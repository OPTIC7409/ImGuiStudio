// studio_runtime.cpp - ImGui Studio widget registry.
//
// Observes every Dear ImGui item through the test-engine hooks
// (IMGUI_ENABLE_TEST_ENGINE), merges in the optional semantic annotations from
// studio.h, and publishes a per-frame snapshot as JSON for the Studio/agents.

#include "studio_runtime.h"
#include "studio.h"
#include "imgui_internal.h"

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace
{
    enum class ValueKind { None, Bool, Int, Float, Double, Floats, Text };

    struct KeyValue
    {
        std::string key;
        std::string json;
    };

    struct Record
    {
        ImGuiID                 id = 0;
        ImGuiWindow*            window = nullptr;   // only dereferenced within the frame that produced the record
        ImGuiID                 windowId = 0;
        std::string             windowName;
        ImRect                  rect;
        ImRect                  clip;
        ImGuiItemFlags          itemFlags = 0;
        ImGuiItemStatusFlags    status = 0;
        bool                    hasInfo = false;
        bool                    isWindow = false;
        bool                    isRegion = false;
        bool                    isPseudo = false;   // created by an annotation on an item without id (e.g. Text)
        bool                    inMenu = false;     // submitted in a menu bar / menu popup
        ImGuiID                 seed = 0;           // ID stack top at submission (for label lookup)
        std::string             label;
        std::string             scope;
        std::string             explicitId;
        std::string             type;
        std::string             semantic;
        std::string             role;               // for anonymous items: titlebar, scrollbar_y, ...
        ValueKind               kind = ValueKind::None;
        void*                   ptr = nullptr;
        int                     count = 0;
        bool                    isColor = false;
        int                     textSize = 0;
        double                  num[4] = { 0, 0, 0, 0 };
        std::string             text;
        std::vector<KeyValue>   state;
        std::vector<std::string> sources;
        int                     order = 0;
        // Finalized fields
        bool                    hovered = false;
        bool                    active = false;
        bool                    focused = false;
        bool                    visible = false;
        ImRect                  visibleRect;
    };

    struct WindowInfo
    {
        ImGuiID     id = 0;
        std::string name;
        std::string semantic;
        ImRect      rect;
        ImVec2      scroll, scrollMax, contentSize;
        ImGuiWindowFlags flags = 0;
        bool        hidden = false, collapsed = false, hovered = false, focused = false;
        int         focusOrder = -1;
        int         beginOrder = 0;
        std::string parent;
    };

    struct PendingWrite
    {
        bool        isText = false;
        int         count = 0;
        double      num[4] = { 0, 0, 0, 0 };
        std::string text;
        int         framesLeft = 120;   // expire if the item is not submitted
    };

    struct State
    {
        bool                                capturing = false;
        std::vector<Record>                 cur;
        std::unordered_map<ImGuiID, int>    curIndex;
        std::vector<Record>                 last;
        std::vector<WindowInfo>             lastWindows;
        int                                 lastFrame = -1;
        double                              lastTime = 0.0;
        std::vector<std::string>            scopes;
        std::string                         scopeJoined;
        int                                 scopeUnbalanced = 0;
        int                                 lastTagged = -1;
        std::unordered_map<ImGuiID, PendingWrite> pending;
        std::string                         json;
        std::string                         frameJson;
        std::vector<std::string>            frameWarnings;
    };

    State& S()
    {
        static State s;
        return s;
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    std::string Slug(const char* s, const char* end = nullptr)
    {
        std::string out;
        if (!s)
            return out;
        if (!end)
            end = s + strlen(s);
        bool pendingSep = false;
        for (const char* p = s; p < end; p++)
        {
            unsigned char c = (unsigned char)*p;
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
            {
                if (pendingSep && !out.empty())
                    out += '_';
                out += (char)c;
                pendingSep = false;
            }
            else if (c >= 'A' && c <= 'Z')
            {
                if (pendingSep && !out.empty())
                    out += '_';
                out += (char)(c - 'A' + 'a');
                pendingSep = false;
            }
            else if (c == '.' && !out.empty())
            {
                out += '.';
                pendingSep = false;
            }
            else
            {
                pendingSep = true;
            }
        }
        return out;
    }

    // "Label##id" -> "id", "Label###id" -> "id", "Label" -> "label"
    std::string LabelSlug(const std::string& label)
    {
        const char* s = label.c_str();
        const char* hash3 = strstr(s, "###");
        if (hash3)
            return Slug(hash3 + 3);
        const char* hash2 = strstr(s, "##");
        if (hash2)
        {
            std::string suffix = Slug(hash2 + 2);
            if (!suffix.empty())
                return suffix;
            return Slug(s, hash2);
        }
        return Slug(s);
    }

    std::string VisibleLabel(const std::string& label)
    {
        size_t p = label.find("##");
        return p == std::string::npos ? label : label.substr(0, p);
    }

    // "Parent/Child_1234ABCD" -> "Child", "Parent/1234ABCD" -> ""
    std::string WindowDisplayName(const char* name)
    {
        if (!name)
            return std::string();
        const char* slash = strrchr(name, '/');
        std::string leaf = slash ? std::string(slash + 1) : std::string(name);
        if (slash)
        {
            // Strip trailing _XXXXXXXX added by BeginChild()
            size_t us = leaf.rfind('_');
            if (us != std::string::npos && leaf.size() - us == 9)
                leaf = leaf.substr(0, us);
            else if (leaf.size() == 8 && leaf.find_first_not_of("0123456789ABCDEF") == std::string::npos)
                leaf.clear();
        }
        size_t p = leaf.find("###");
        if (p != std::string::npos)
            return leaf.substr(p + 3);
        p = leaf.find("##");
        if (p != std::string::npos)
        {
            std::string pre = leaf.substr(0, p);
            return pre.empty() ? leaf.substr(p + 2) : pre;
        }
        return leaf;
    }

    std::string RootWindowSlug(ImGuiWindow* window)
    {
        if (!window)
            return std::string();
        ImGuiWindow* root = window->RootWindow ? window->RootWindow : window;
        return Slug(WindowDisplayName(root->Name).c_str());
    }

    void JsonEscape(std::string& out, const char* s)
    {
        out += '"';
        for (const unsigned char* p = (const unsigned char*)s; *p; p++)
        {
            unsigned char c = *p;
            switch (c)
            {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20)
                {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                }
                else
                    out += (char)c;
            }
        }
        out += '"';
    }

    void JsonStr(std::string& out, const std::string& s) { JsonEscape(out, s.c_str()); }

    void JsonNum(std::string& out, double v)
    {
        if (!std::isfinite(v))
        {
            out += "null";
            return;
        }
        char buf[32];
        double r = std::round(v);
        if (std::fabs(v - r) < 1e-9 && std::fabs(v) < 1e15)
            snprintf(buf, sizeof(buf), "%.0f", r);
        else
            snprintf(buf, sizeof(buf), "%.6g", v);
        out += buf;
    }

    void JsonRect(std::string& out, const ImRect& r)
    {
        out += "{\"x\":";
        JsonNum(out, r.Min.x);
        out += ",\"y\":";
        JsonNum(out, r.Min.y);
        out += ",\"width\":";
        JsonNum(out, r.GetWidth());
        out += ",\"height\":";
        JsonNum(out, r.GetHeight());
        out += '}';
    }

    std::string HexId(ImGuiID id)
    {
        char buf[16];
        snprintf(buf, sizeof(buf), "0x%08X", id);
        return buf;
    }

    std::string Source(const char* file, int line)
    {
        if (!file)
            return std::string();
        char buf[16];
        snprintf(buf, sizeof(buf), ":%d", line);
        return std::string(file) + buf;
    }

    void AddSource(Record& r, const char* file, int line)
    {
        std::string src = Source(file, line);
        if (src.empty())
            return;
        for (const std::string& s : r.sources)
            if (s == src)
                return;
        if (r.sources.size() < 4)
            r.sources.push_back(src);
    }

    Record* FindCur(ImGuiID id)
    {
        State& s = S();
        auto it = s.curIndex.find(id);
        return it == s.curIndex.end() ? nullptr : &s.cur[it->second];
    }

    Record& NewRecord(ImGuiID id, ImGuiWindow* window, const ImRect& bb)
    {
        State& s = S();
        s.cur.emplace_back();
        Record& r = s.cur.back();
        r.id = id;
        r.window = window;
        r.windowId = window ? window->ID : 0;
        r.windowName = window ? window->Name : "";
        r.rect = bb;
        if (window && window->DrawList)
        {
            const ImVec4& c = window->DrawList->_CmdHeader.ClipRect;
            r.clip = ImRect(c.x, c.y, c.z, c.w);
        }
        else
        {
            r.clip = bb;
        }
        r.scope = s.scopeJoined;
        if (window)
        {
            r.seed = window->IDStack.Size > 0 ? window->IDStack.back() : window->ID;
            r.inMenu = window->DC.NavLayerCurrent == ImGuiNavLayer_Menu || (window->Flags & (ImGuiWindowFlags_ChildMenu | ImGuiWindowFlags_MenuBar)) != 0 ||
                       ((window->Flags & ImGuiWindowFlags_Popup) && window->RootWindow && (window->RootWindow->Flags & ImGuiWindowFlags_ChildMenu));
        }
        r.order = (int)s.cur.size() - 1;
        s.curIndex[id] = r.order;
        return r;
    }

    // Record for the last submitted item. Creates a pseudo record for items without id (Text, Image, ...)
    Record* LastItemRecord(const char* pseudoId)
    {
        ImGuiContext& g = *GImGui;
        State& s = S();
        if (!s.capturing)
            return nullptr;
        if (g.LastItemData.ID != 0)
        {
            if (Record* r = FindCur(g.LastItemData.ID))
            {
                s.lastTagged = r->order;
                return r;
            }
            Record& r = NewRecord(g.LastItemData.ID, g.CurrentWindow, g.LastItemData.Rect);
            r.itemFlags = g.LastItemData.ItemFlags;
            r.status = g.LastItemData.StatusFlags;
            s.lastTagged = r.order;
            return &r;
        }
        // Items without id (Text, Image, ...): key by explicit id, or by the item rectangle.
        ImGuiID seed = g.CurrentWindow ? g.CurrentWindow->ID : 0;
        ImGuiID id = pseudoId ? ImHashStr(pseudoId, 0, seed) : ImHashData(&g.LastItemData.Rect, sizeof(ImRect), seed);
        if (Record* r = FindCur(id))
        {
            s.lastTagged = r->order;
            return r;
        }
        Record& r = NewRecord(id, g.CurrentWindow, g.LastItemData.Rect);
        r.isPseudo = true;
        s.lastTagged = r.order;
        return &r;
    }

    Record* LastTagged()
    {
        ImGuiContext& g = *GImGui;
        State& s = S();
        if (!s.capturing)
            return nullptr;
        if (g.LastItemData.ID != 0)
            if (Record* r = FindCur(g.LastItemData.ID))
                return r;
        if (s.lastTagged >= 0 && s.lastTagged < (int)s.cur.size())
            return &s.cur[s.lastTagged];
        return nullptr;
    }

    void SnapshotValue(Record& r)
    {
        switch (r.kind)
        {
        case ValueKind::Bool: r.num[0] = *(bool*)r.ptr ? 1.0 : 0.0; break;
        case ValueKind::Int: r.num[0] = *(int*)r.ptr; break;
        case ValueKind::Float: r.num[0] = *(float*)r.ptr; break;
        case ValueKind::Double: r.num[0] = *(double*)r.ptr; break;
        case ValueKind::Floats:
            for (int i = 0; i < r.count && i < 4; i++)
                r.num[i] = ((float*)r.ptr)[i];
            break;
        case ValueKind::Text: r.text = (const char*)r.ptr; break;
        default: break;
        }
    }

    // Apply a queued set_value request when the bound item is submitted.
    void ApplyPending(Record& r)
    {
        State& s = S();
        auto it = s.pending.find(r.id);
        if (it == s.pending.end())
            return;
        PendingWrite& w = it->second;
        switch (r.kind)
        {
        case ValueKind::Bool: if (w.count > 0) *(bool*)r.ptr = w.num[0] != 0.0; break;
        case ValueKind::Int: if (w.count > 0) *(int*)r.ptr = (int)std::lround(w.num[0]); break;
        case ValueKind::Float: if (w.count > 0) *(float*)r.ptr = (float)w.num[0]; break;
        case ValueKind::Double: if (w.count > 0) *(double*)r.ptr = w.num[0]; break;
        case ValueKind::Floats:
            for (int i = 0; i < r.count && i < w.count; i++)
                ((float*)r.ptr)[i] = (float)w.num[i];
            break;
        case ValueKind::Text:
            if (r.textSize > 0)
            {
                ImStrncpy((char*)r.ptr, w.text.c_str(), (size_t)r.textSize);
            }
            break;
        default: return;
        }
        s.pending.erase(it);
    }

    void Bind(ValueKind kind, void* ptr, int count, bool isColor, int textSize, const char* file, int line)
    {
        Record* r = LastItemRecord(nullptr);
        if (!r || !ptr)
            return;
        r->kind = kind;
        r->ptr = ptr;
        r->count = count;
        r->isColor = isColor;
        r->textSize = textSize;
        AddSource(*r, file, line);
        ApplyPending(*r);
        SnapshotValue(*r);
    }

    void AddState(const char* key, const std::string& json)
    {
        Record* r = LastTagged();
        if (!r || !key)
            return;
        for (KeyValue& kv : r->state)
        {
            if (kv.key == key)
            {
                kv.json = json;
                return;
            }
        }
        r->state.push_back({ key, json });
    }

    const char* InferType(const Record& r)
    {
        if (!r.type.empty())
            return r.type.c_str();
        if (r.isWindow)
            return "window";
        if (r.isRegion)
            return "region";
        if (!r.role.empty())
            return r.role.c_str();
        if (r.isPseudo)
            return "item";
        if (r.status & ImGuiItemStatusFlags_Checkable)
            return r.inMenu ? "menu_item" : "checkbox";
        if (r.status & ImGuiItemStatusFlags_Openable)
        {
            if (r.status & ImGuiItemStatusFlags_HasDisplayRect)
                return "tree_node";
            return r.inMenu ? "menu" : "combo";
        }
        if (r.status & ImGuiItemStatusFlags_Inputable)
            return "input";
        if (r.hasInfo)
            return "button";
        return "item";
    }

    void WriteValue(std::string& out, const Record& r)
    {
        switch (r.kind)
        {
        case ValueKind::Bool: out += r.num[0] != 0.0 ? "true" : "false"; break;
        case ValueKind::Int:
        case ValueKind::Float:
        case ValueKind::Double: JsonNum(out, r.num[0]); break;
        case ValueKind::Floats:
            out += '[';
            for (int i = 0; i < r.count && i < 4; i++)
            {
                if (i)
                    out += ',';
                JsonNum(out, r.num[i]);
            }
            out += ']';
            break;
        case ValueKind::Text: JsonStr(out, r.text); break;
        default: out += "null"; break;
        }
    }

    const char* KindName(const Record& r)
    {
        switch (r.kind)
        {
        case ValueKind::Bool: return "bool";
        case ValueKind::Int: return "int";
        case ValueKind::Float: return "float";
        case ValueKind::Double: return "double";
        case ValueKind::Floats: return r.isColor ? "color" : "float_array";
        case ValueKind::Text: return "text";
        default: return "none";
        }
    }

    void Finalize()
    {
        ImGuiContext& g = *GImGui;
        State& s = S();

        // Classify anonymous window-owned items (title bars, scrollbars, resize grips).
        for (Record& r : s.cur)
        {
            if (r.hasInfo || r.isWindow || r.isRegion || !r.explicitId.empty() || !r.window)
                continue;
            ImGuiWindow* w = r.window;
            if (r.id == w->MoveId)
                r.role = "titlebar";
            else if (r.id == ImGui::GetWindowScrollbarID(w, ImGuiAxis_X))
                r.role = "scrollbar_x";
            else if (r.id == ImGui::GetWindowScrollbarID(w, ImGuiAxis_Y))
                r.role = "scrollbar_y";
            else
            {
                for (int n = 0; n < 4 && r.role.empty(); n++)
                    if (r.id == ImGui::GetWindowResizeCornerID(w, n))
                        r.role = "resize_grip";
                for (int d = 0; d < 4 && r.role.empty(); d++)
                    if (r.id == ImGui::GetWindowResizeBorderID(w, (ImGuiDir)d))
                        r.role = "resize_border";
            }
        }

        // Hover / active / focus / visibility.
        for (Record& r : s.cur)
        {
            ImGuiWindow* w = r.window;
            if (r.isWindow)
            {
                r.hovered = g.HoveredWindow == w;
                r.active = false;
                r.focused = g.NavWindow == w;
                r.visible = w && w->Active && !w->Hidden;
                r.visibleRect = r.rect;
            }
            else
            {
                r.hovered = r.id != 0 && r.id == g.HoveredId;
                r.active = r.id != 0 && r.id == g.ActiveId;
                r.focused = r.id != 0 && r.id == g.NavId && g.NavWindow == w && (g.NavCursorVisible || g.ActiveId == r.id);
                ImRect vr = r.rect;
                vr.ClipWithFull(r.clip);
                bool windowVisible = !w || (w->Active && !w->Hidden && !w->Collapsed);
                r.visible = windowVisible && vr.GetWidth() > 0.0f && vr.GetHeight() > 0.0f;
                r.visibleRect = r.visible ? vr : ImRect(r.rect.Min, r.rect.Min);
            }
        }

        // Semantic ids
        std::unordered_map<std::string, int> used;
        for (Record& r : s.cur)
        {
            std::string base;
            if (!r.explicitId.empty())
                base = r.explicitId;
            else if (r.isWindow)
                base = "window." + Slug(WindowDisplayName(r.windowName.c_str()).c_str());
            else
            {
                std::string prefix = !r.scope.empty() ? r.scope : RootWindowSlug(r.window);
                std::string leaf;
                if (!r.role.empty())
                {
                    std::string owner = r.window ? Slug(WindowDisplayName(r.window->Name).c_str()) : std::string();
                    leaf = (owner.empty() ? std::string() : owner + ".") + r.role;
                    prefix = RootWindowSlug(r.window);
                    if (!owner.empty() && owner == prefix)
                        leaf = r.role;
                }
                else if (!r.label.empty())
                    leaf = LabelSlug(r.label);
                if (leaf.empty())
                {
                    char buf[16];
                    snprintf(buf, sizeof(buf), "item_%08x", r.id);
                    leaf = buf;
                }
                base = prefix.empty() ? leaf : prefix + "." + leaf;
            }
            int& n = used[base];
            n++;
            if (n == 1)
                r.semantic = base;
            else
            {
                char buf[16];
                snprintf(buf, sizeof(buf), "#%d", n);
                r.semantic = base + buf;
            }
        }

        // Windows
        s.lastWindows.clear();
        for (ImGuiWindow* w : g.Windows)
        {
            if (!w->Active || w->IsFallbackWindow)
                continue;
            WindowInfo wi;
            wi.id = w->ID;
            wi.name = w->Name;
            wi.semantic = "window." + Slug(WindowDisplayName(w->Name).c_str());
            wi.rect = w->Rect();
            wi.scroll = w->Scroll;
            wi.scrollMax = w->ScrollMax;
            wi.contentSize = w->ContentSize;
            wi.flags = w->Flags;
            wi.hidden = w->Hidden;
            wi.collapsed = w->Collapsed;
            wi.hovered = g.HoveredWindow == w;
            wi.focused = g.NavWindow == w;
            wi.focusOrder = w->FocusOrder;
            wi.beginOrder = w->BeginOrderWithinContext;
            wi.parent = w->ParentWindow ? w->ParentWindow->Name : "";
            s.lastWindows.push_back(wi);
        }

        for (Record& r : s.cur)
            r.window = nullptr;     // do not keep raw pointers beyond the frame

        s.last.swap(s.cur);
        s.cur.clear();
        s.curIndex.clear();
        s.lastFrame = g.FrameCount;
        s.lastTime = g.Time;
        s.json.clear();
        s.frameJson.clear();

        // Expire stale pending writes
        for (auto it = s.pending.begin(); it != s.pending.end();)
        {
            if (--it->second.framesLeft <= 0)
                it = s.pending.erase(it);
            else
                ++it;
        }
    }

    const char* WindowFlagsType(ImGuiWindowFlags f)
    {
        if (f & ImGuiWindowFlags_Tooltip) return "tooltip";
        if (f & ImGuiWindowFlags_Modal) return "modal";
        if (f & ImGuiWindowFlags_Popup) return "popup";
        if (f & ImGuiWindowFlags_ChildMenu) return "menu";
        if (f & ImGuiWindowFlags_ChildWindow) return "child";
        return "window";
    }
}

// ----------------------------------------------------------------------------
// Dear ImGui test-engine hooks
// ----------------------------------------------------------------------------

void ImGuiTestEngineHook_ItemAdd(ImGuiContext* ctx, ImGuiID id, const ImRect& bb, const ImGuiLastItemData* item_data)
{
    State& s = S();
    if (!s.capturing || id == 0)
        return;
    ImGuiContext& g = *ctx;
    ImGuiWindow* window = g.CurrentWindow;

    // A window registers itself (item_data == NULL) with its own id.
    if (item_data == nullptr && window && id == window->ID)
    {
        Record& r = NewRecord(id, window, bb);
        r.isWindow = true;
        r.clip = bb;
        return;
    }

    if (Record* existing = FindCur(id))
    {
        // Same item registered twice with identical bounds (some widgets do): merge.
        if (existing->rect.Min.x == bb.Min.x && existing->rect.Min.y == bb.Min.y &&
            existing->rect.Max.x == bb.Max.x && existing->rect.Max.y == bb.Max.y)
            return;
    }
    Record& r = NewRecord(id, window, bb);
    if (item_data)
    {
        r.itemFlags = item_data->ItemFlags;
        r.status = item_data->StatusFlags;
        if (item_data->StatusFlags & ImGuiItemStatusFlags_HasClipRect)
        {
            ImRect c = item_data->ClipRect;
            r.clip.ClipWithFull(c);
        }
    }
}

void ImGuiTestEngineHook_ItemInfo(ImGuiContext* ctx, ImGuiID id, const char* label, ImGuiItemStatusFlags flags)
{
    State& s = S();
    if (!s.capturing || id == 0)
        return;
    ImGuiContext& g = *ctx;
    Record* r = FindCur(id);
    if (!r)
    {
        ImRect bb = g.LastItemData.ID == id ? g.LastItemData.Rect : ImRect();
        r = &NewRecord(id, g.CurrentWindow, bb);
    }
    if (label && !r->isWindow)
        r->label = label;
    r->status |= flags;
    r->hasInfo = true;
}

void ImGuiTestEngineHook_Log(ImGuiContext* ctx, const char* fmt, ...)
{
    IM_UNUSED(ctx);
    char buf[2048];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    int level = strstr(buf, "[imgui-error]") ? 2 : 0;
    StudioRuntime::HostLog(level, buf);
}

const char* ImGuiTestEngine_FindItemDebugLabel(ImGuiContext* ctx, ImGuiID id)
{
    IM_UNUSED(ctx);
    State& s = S();
    for (const Record& r : s.last)
        if (r.id == id && !r.label.empty())
            return r.label.c_str();
    return nullptr;
}

// ----------------------------------------------------------------------------
// Public instrumentation API (studio.h)
// ----------------------------------------------------------------------------

namespace Studio
{
    void PushScope(const char* name)
    {
        State& s = S();
        s.scopes.push_back(name ? name : "");
        s.scopeJoined.clear();
        for (const std::string& sc : s.scopes)
        {
            if (sc.empty())
                continue;
            if (!s.scopeJoined.empty())
                s.scopeJoined += '.';
            s.scopeJoined += sc;
        }
    }

    void PopScope()
    {
        State& s = S();
        if (s.scopes.empty())
        {
            s.scopeUnbalanced++;
            return;
        }
        s.scopes.pop_back();
        s.scopeJoined.clear();
        for (const std::string& sc : s.scopes)
        {
            if (sc.empty())
                continue;
            if (!s.scopeJoined.empty())
                s.scopeJoined += '.';
            s.scopeJoined += sc;
        }
    }

    void SetItemId(const char* id, const char* file, int line)
    {
        Record* r = LastItemRecord(id);
        if (!r || !id)
            return;
        r->explicitId = id;
        AddSource(*r, file, line);
    }

    void SetItemType(const char* type, const char* file, int line)
    {
        Record* r = LastItemRecord(nullptr);
        if (!r || !type)
            return;
        r->type = type;
        AddSource(*r, file, line);
    }

    void BindValue(bool* v, const char* file, int line) { Bind(ValueKind::Bool, v, 1, false, 0, file, line); }
    void BindValue(int* v, const char* file, int line) { Bind(ValueKind::Int, v, 1, false, 0, file, line); }
    void BindValue(float* v, const char* file, int line) { Bind(ValueKind::Float, v, 1, false, 0, file, line); }
    void BindValue(double* v, const char* file, int line) { Bind(ValueKind::Double, v, 1, false, 0, file, line); }
    void BindValue(ImVec2* v, const char* file, int line) { Bind(ValueKind::Floats, v ? &v->x : nullptr, 2, false, 0, file, line); }
    void BindValue(ImVec4* v, const char* file, int line) { Bind(ValueKind::Floats, v ? &v->x : nullptr, 4, true, 0, file, line); }
    void BindFloats(float* v, int count, bool is_color, const char* file, int line) { Bind(ValueKind::Floats, v, ImClamp(count, 1, 4), is_color, 0, file, line); }
    void BindText(char* buf, int buf_size, const char* file, int line) { Bind(ValueKind::Text, buf, 1, false, buf_size, file, line); }

    void SetState(const char* key, bool v) { AddState(key, v ? "true" : "false"); }
    void SetState(const char* key, int v) { std::string j; JsonNum(j, v); AddState(key, j); }
    void SetState(const char* key, unsigned int v) { std::string j; JsonNum(j, v); AddState(key, j); }
    void SetState(const char* key, float v) { std::string j; JsonNum(j, v); AddState(key, j); }
    void SetState(const char* key, double v) { std::string j; JsonNum(j, v); AddState(key, j); }
    void SetState(const char* key, const char* v) { std::string j; JsonEscape(j, v ? v : ""); AddState(key, j); }
    void SetState(const char* key, const ImVec2& v)
    {
        std::string j = "[";
        JsonNum(j, v.x); j += ','; JsonNum(j, v.y); j += ']';
        AddState(key, j);
    }
    void SetState(const char* key, const ImVec4& v)
    {
        std::string j = "[";
        JsonNum(j, v.x); j += ','; JsonNum(j, v.y); j += ','; JsonNum(j, v.z); j += ','; JsonNum(j, v.w); j += ']';
        AddState(key, j);
    }

    void AddRegion(const char* id, const ImVec2& min, const ImVec2& max, const char* file, int line)
    {
        State& s = S();
        if (!s.capturing || !id)
            return;
        ImGuiContext& g = *GImGui;
        ImGuiID hid = ImHashStr(id, 0, 0x5354554Eu);
        Record* r = FindCur(hid);
        if (!r)
            r = &NewRecord(hid, g.CurrentWindow, ImRect(min, max));
        r->rect = ImRect(min, max);
        r->isRegion = true;
        r->explicitId = id;
        AddSource(*r, file, line);
        s.lastTagged = r->order;
    }
}

// ----------------------------------------------------------------------------
// Host-facing API
// ----------------------------------------------------------------------------

namespace StudioRuntime
{
    void Init()
    {
        ImGuiContext& g = *GImGui;
        g.TestEngineHookItems = true;
        g.DebugLogFlags = ImGuiDebugLogFlags_EventError | ImGuiDebugLogFlags_OutputToTestEngine;
        ImGuiIO& io = ImGui::GetIO();
        io.ConfigErrorRecovery = true;
        io.ConfigErrorRecoveryEnableAssert = false;     // report recoverable misuse instead of crashing the preview
        io.ConfigErrorRecoveryEnableDebugLog = true;
        io.ConfigErrorRecoveryEnableTooltip = false;    // keep captures clean; errors are reported to the Studio
    }

    void PreNewFrame()
    {
        State& s = S();
        ImGuiContext& g = *GImGui;
        g.TestEngineHookItems = true;
        s.cur.clear();
        s.curIndex.clear();
        s.lastTagged = -1;
        if (!s.scopes.empty() || s.scopeUnbalanced)
        {
            HostLog(1, "STUDIO_SCOPE push/pop mismatch detected during the previous frame");
            s.scopes.clear();
            s.scopeJoined.clear();
            s.scopeUnbalanced = 0;
        }
        s.capturing = true;
    }

    void PostRender()
    {
        State& s = S();
        if (!s.capturing)
            return;
        Finalize();
        s.capturing = false;
    }

    const char* WidgetsJson()
    {
        State& s = S();
        if (!s.json.empty())
            return s.json.c_str();
        std::string& o = s.json;
        o.reserve(64 * 1024);
        o += "{\"frame\":";
        JsonNum(o, s.lastFrame);
        o += ",\"time\":";
        JsonNum(o, s.lastTime);
        o += ",\"widgets\":[";
        bool first = true;
        for (const Record& r : s.last)
        {
            if (!first)
                o += ',';
            first = false;
            o += "{\"id\":";
            JsonStr(o, r.semantic);
            o += ",\"imgui_id\":";
            JsonStr(o, HexId(r.id));
            o += ",\"type\":";
            JsonEscape(o, InferType(r));
            o += ",\"label\":";
            JsonStr(o, r.isWindow ? WindowDisplayName(r.windowName.c_str()) : VisibleLabel(r.label));
            if (!r.label.empty() && r.label.find("##") != std::string::npos)
            {
                o += ",\"raw_label\":";
                JsonStr(o, r.label);
            }
            o += ",\"window\":";
            JsonStr(o, r.windowName);
            if (!r.scope.empty())
            {
                o += ",\"scope\":";
                JsonStr(o, r.scope);
            }
            o += ",\"bounds\":";
            JsonRect(o, r.rect);
            if (r.visible && (r.visibleRect.Min.x != r.rect.Min.x || r.visibleRect.Min.y != r.rect.Min.y ||
                              r.visibleRect.Max.x != r.rect.Max.x || r.visibleRect.Max.y != r.rect.Max.y))
            {
                o += ",\"visible_bounds\":";
                JsonRect(o, r.visibleRect);
            }
            o += ",\"visible\":";
            o += r.visible ? "true" : "false";
            o += ",\"explicit\":";
            o += (!r.explicitId.empty() || !r.type.empty() || r.kind != ValueKind::None) ? "true" : "false";
            o += ",\"state\":{\"hovered\":";
            o += r.hovered ? "true" : "false";
            o += ",\"active\":";
            o += r.active ? "true" : "false";
            o += ",\"focused\":";
            o += r.focused ? "true" : "false";
            if (r.status & ImGuiItemStatusFlags_Checkable)
            {
                o += ",\"checked\":";
                o += (r.status & ImGuiItemStatusFlags_Checked) ? "true" : "false";
            }
            if (r.status & ImGuiItemStatusFlags_Openable)
            {
                o += ",\"open\":";
                o += (r.status & ImGuiItemStatusFlags_Opened) ? "true" : "false";
            }
            if (r.status & ImGuiItemStatusFlags_Edited)
                o += ",\"edited\":true";
            if (r.itemFlags & ImGuiItemFlags_Disabled)
                o += ",\"disabled\":true";
            if (r.kind != ValueKind::None)
            {
                o += ",\"value\":";
                WriteValue(o, r);
            }
            for (const KeyValue& kv : r.state)
            {
                o += ',';
                JsonStr(o, kv.key);
                o += ':';
                o += kv.json;
            }
            o += '}';
            if (r.kind != ValueKind::None)
            {
                o += ",\"value_type\":";
                JsonEscape(o, KindName(r));
                o += ",\"settable\":true";
            }
            else if (r.status & ImGuiItemStatusFlags_Inputable)
            {
                o += ",\"text_input\":true";
            }
            if (!r.sources.empty())
            {
                o += ",\"source\":[";
                for (size_t i = 0; i < r.sources.size(); i++)
                {
                    if (i)
                        o += ',';
                    JsonStr(o, r.sources[i]);
                }
                o += ']';
            }
            o += ",\"order\":";
            JsonNum(o, r.order);
            if (!r.hasInfo && !r.isWindow && !r.isRegion && r.explicitId.empty() && r.type.empty() && r.kind == ValueKind::None)
                o += ",\"anonymous\":true";
            o += '}';
        }
        o += "],\"windows\":[";
        first = true;
        for (const WindowInfo& w : s.lastWindows)
        {
            if (!first)
                o += ',';
            first = false;
            o += "{\"id\":";
            JsonStr(o, w.semantic);
            o += ",\"imgui_id\":";
            JsonStr(o, HexId(w.id));
            o += ",\"name\":";
            JsonStr(o, w.name);
            o += ",\"kind\":";
            JsonEscape(o, WindowFlagsType(w.flags));
            o += ",\"bounds\":";
            JsonRect(o, w.rect);
            o += ",\"scroll\":[";
            JsonNum(o, w.scroll.x); o += ','; JsonNum(o, w.scroll.y);
            o += "],\"scroll_max\":[";
            JsonNum(o, w.scrollMax.x); o += ','; JsonNum(o, w.scrollMax.y);
            o += "],\"content_size\":[";
            JsonNum(o, w.contentSize.x); o += ','; JsonNum(o, w.contentSize.y);
            o += "],\"hidden\":";
            o += w.hidden ? "true" : "false";
            o += ",\"collapsed\":";
            o += w.collapsed ? "true" : "false";
            o += ",\"hovered\":";
            o += w.hovered ? "true" : "false";
            o += ",\"focused\":";
            o += w.focused ? "true" : "false";
            o += ",\"focus_order\":";
            JsonNum(o, w.focusOrder);
            o += ",\"begin_order\":";
            JsonNum(o, w.beginOrder);
            if (!w.parent.empty())
            {
                o += ",\"parent\":";
                JsonStr(o, w.parent);
            }
            o += '}';
        }
        o += "]}";
        return o.c_str();
    }

    const char* FrameJson()
    {
        State& s = S();
        ImGuiContext& g = *GImGui;
        ImGuiIO& io = g.IO;
        std::string& o = s.frameJson;
        o.clear();
        o += "{\"frame\":";
        JsonNum(o, g.FrameCount);
        o += ",\"time\":";
        JsonNum(o, g.Time);
        o += ",\"delta_time\":";
        JsonNum(o, io.DeltaTime);
        o += ",\"display_size\":[";
        JsonNum(o, io.DisplaySize.x); o += ','; JsonNum(o, io.DisplaySize.y);
        o += "],\"mouse\":[";
        JsonNum(o, io.MousePos.x); o += ','; JsonNum(o, io.MousePos.y);
        o += "],\"mouse_down\":[";
        for (int i = 0; i < 3; i++)
        {
            if (i)
                o += ',';
            o += io.MouseDown[i] ? "true" : "false";
        }
        o += "],\"hovered_id\":";
        JsonStr(o, HexId(g.HoveredId));
        o += ",\"active_id\":";
        JsonStr(o, HexId(g.ActiveId));
        o += ",\"hovered_window\":";
        JsonStr(o, g.HoveredWindow ? g.HoveredWindow->Name : "");
        o += ",\"focused_window\":";
        JsonStr(o, g.NavWindow ? g.NavWindow->Name : "");
        o += ",\"want_text_input\":";
        o += io.WantTextInput ? "true" : "false";
        o += ",\"mouse_cursor\":";
        JsonNum(o, ImGui::GetMouseCursor());
        o += ",\"vertices\":";
        JsonNum(o, io.MetricsRenderVertices);
        o += ",\"indices\":";
        JsonNum(o, io.MetricsRenderIndices);
        o += ",\"windows\":";
        JsonNum(o, io.MetricsRenderWindows);
        o += '}';
        return o.c_str();
    }

    void QueueSetNumbers(ImGuiID id, int count, const double* values)
    {
        PendingWrite w;
        w.count = ImClamp(count, 0, 4);
        for (int i = 0; i < w.count; i++)
            w.num[i] = values[i];
        S().pending[id] = w;
    }

    void QueueSetText(ImGuiID id, const char* text)
    {
        PendingWrite w;
        w.isText = true;
        w.text = text ? text : "";
        S().pending[id] = w;
    }

    const char* FindByLabelJson(const char* label)
    {
        State& s = S();
        static std::string out;
        out = "[";
        bool first = true;
        if (label && *label)
        {
            for (const Record& r : s.last)
            {
                if (r.isWindow || r.isRegion || r.id == 0)
                    continue;
                if (ImHashStr(label, 0, r.seed) != r.id)
                    continue;
                if (!first)
                    out += ',';
                first = false;
                JsonStr(out, r.semantic);
            }
        }
        out += ']';
        return out.c_str();
    }

    bool ScrollItemIntoView(ImGuiID id)
    {
        State& s = S();
        for (const Record& r : s.last)
        {
            if (r.id != id || r.isWindow)
                continue;
            ImGuiWindow* window = ImGui::FindWindowByID(r.windowId);
            if (!window)
                return false;
            ImGui::ScrollToRect(window, r.rect, ImGuiScrollFlags_KeepVisibleEdgeY | ImGuiScrollFlags_KeepVisibleEdgeX);
            // Parent windows may need to scroll too (nested child windows).
            ImGuiWindow* child = window;
            while (child->ParentWindow && (child->Flags & ImGuiWindowFlags_ChildWindow))
            {
                ImGui::ScrollToRect(child->ParentWindow, child->Rect(), ImGuiScrollFlags_KeepVisibleEdgeY | ImGuiScrollFlags_KeepVisibleEdgeX);
                child = child->ParentWindow;
            }
            return true;
        }
        return false;
    }
}
