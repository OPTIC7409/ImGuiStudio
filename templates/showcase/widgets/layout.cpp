// layout.cpp - cards, navigation, buttons, search, charts, toasts and drawing helpers.
#include "widgets.hpp"
#include "internal.hpp"

#include "studio.h"

#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace ui::detail;

namespace ui
{
    float& MotionScale()
    {
        static float s = 1.0f;
        return s;
    }

    // ------------------------------------------------------------------------
    // Drawing helpers
    // ------------------------------------------------------------------------
    void TextAt(ImDrawList* dl, ImFont* font, float size, const ImVec2& pos, ImU32 col, const char* text)
    {
        dl->AddText(font, size, ImVec2(IM_TRUNC(pos.x), IM_TRUNC(pos.y)), col, text);
    }

    ImVec2 TextSize(ImFont* font, float size, const char* text)
    {
        return font->CalcTextSizeA(size, FLT_MAX, 0.0f, text);
    }

    // Layered translucent rounded rects approximate a gaussian drop shadow.
    void SoftShadow(ImDrawList* dl, const ImVec2& min, const ImVec2& max, float rounding, float spread, ImU32 col)
    {
        const ImVec4 c = ImGui::ColorConvertU32ToFloat4(col);
        const int steps = 10;
        for (int i = steps; i >= 1; i--)
        {
            const float t = (float)i / steps;
            const float grow = spread * t;
            const float a = c.w * (1.0f - t) * (1.0f - t) * 0.35f;
            dl->AddRectFilled(ImVec2(min.x - grow, min.y - grow + spread * 0.25f), ImVec2(max.x + grow, max.y + grow + spread * 0.25f), ImGui::GetColorU32(ImVec4(c.x, c.y, c.z, a)), rounding + grow);
        }
    }

    // ------------------------------------------------------------------------
    // Search filter
    // ------------------------------------------------------------------------
    static char g_Filter[128] = "";
    static int g_FilteredOut = 0;

    void SetFilter(const char* text)
    {
        ImStrncpy(g_Filter, text ? text : "", sizeof(g_Filter));
        g_FilteredOut = 0;
    }

    static bool ContainsNoCase(const char* hay, const char* needle)
    {
        if (!hay)
            return false;
        const size_t n = strlen(needle);
        for (const char* p = hay; *p; p++)
        {
            size_t i = 0;
            while (i < n && p[i] && tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i]))
                i++;
            if (i == n)
                return true;
        }
        return false;
    }

    bool PassFilter(const char* label, const char* description)
    {
        if (!g_Filter[0])
            return true;
        if (ContainsNoCase(label, g_Filter) || ContainsNoCase(description, g_Filter))
            return true;
        g_FilteredOut++;
        return false;
    }

    int FilteredOutCount() { return g_FilteredOut; }

    // ------------------------------------------------------------------------
    // Cards: an auto-height child window; background and shadow are drawn by the
    // parent after EndChild() so they render underneath the card's contents.
    // ------------------------------------------------------------------------
    struct CardInfo
    {
        std::string id;
    };
    static std::vector<CardInfo> g_Cards;

    bool BeginCard(const char* id, const char* title, const char* subtitle, float width)
    {
        ImGui::PushID(id);
        g_Cards.push_back({ id });
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(8.0f, 10.0f));
        ImGui::BeginChild("##card", ImVec2(width, 0.0f), ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
        ImGui::PopStyleVar();

        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 p = ImGui::GetCursorScreenPos();
        TextAt(dl, f.semibold, 15.0f, ImVec2(p.x + kRowPadX, p.y + 6.0f), theme::Col(c.text), title);
        float h = 30.0f;
        if (subtitle)
        {
            TextAt(dl, f.regular, theme::kSmall, ImVec2(p.x + kRowPadX, p.y + 26.0f), theme::Col(c.textDim), subtitle);
            h += 18.0f;
        }
        ImGui::Dummy(ImVec2(1.0f, h));
        ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(8.0f, 2.0f));
        return true;
    }

    void EndCard()
    {
        ImGui::PopStyleVar();
        ImGui::Dummy(ImVec2(1.0f, 2.0f));
        ImGui::EndChild();
        const ImVec2 min = ImGui::GetItemRectMin();
        const ImVec2 max = ImGui::GetItemRectMax();
        const theme::Palette& c = theme::Colors();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        SoftShadow(dl, min, max, theme::kRadius, 14.0f, IM_COL32(0, 0, 0, 200));
        dl->AddRectFilled(min, max, theme::Col(c.card), theme::kRadius);
        dl->AddRect(min, max, theme::Col(c.cardBorder), theme::kRadius, 0, 1.0f);
        // Subtle top highlight
        dl->AddLine(ImVec2(min.x + theme::kRadius, min.y + 0.5f), ImVec2(max.x - theme::kRadius, min.y + 0.5f), IM_COL32(255, 255, 255, 14), 1.0f);
        STUDIO_REGION(g_Cards.back().id.c_str(), min, max);
        g_Cards.pop_back();
        ImGui::PopID();
    }

    void SectionLabel(const char* text)
    {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 p = ImGui::GetCursorScreenPos();
        TextAt(dl, theme::Font().semibold, theme::kSection, ImVec2(p.x + 16.0f, p.y + 4.0f), theme::Col(theme::Colors().textFaint), text);
        ImGui::Dummy(ImVec2(1.0f, 24.0f));
    }

    void Divider()
    {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 p = ImGui::GetCursorScreenPos();
        const float w = ImGui::GetContentRegionAvail().x;
        dl->AddLine(ImVec2(p.x, p.y + 0.5f), ImVec2(p.x + w, p.y + 0.5f), theme::Col(theme::Colors().divider), 1.0f);
        ImGui::Dummy(ImVec2(w, 1.0f));
    }

    // ------------------------------------------------------------------------
    // Sidebar navigation item
    // ------------------------------------------------------------------------
    bool NavItem(const char* label, Icon icon, bool selected, float label_alpha)
    {
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const ImVec2 pos = window->DC.CursorPos;
        const ImRect bb(pos, ImVec2(pos.x + ImGui::GetContentRegionAvail().x, pos.y + 40.0f));
        ImGui::ItemSize(bb);
        if (!ImGui::ItemAdd(bb, id))
            return false;
        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(bb, id, &hovered, &held);
        STUDIO_WIDGET("nav_item");
        STUDIO_LABEL(label);
        STUDIO_STATE("selected", selected);

        const float hv = Animate(id, 0, hovered ? 1.0f : 0.0f, 0.12f);
        const float sel = Animate(id, 1, selected ? 1.0f : 0.0f, 0.18f);
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        ImDrawList* dl = window->DrawList;
        if (hv > 0.01f && !selected)
            dl->AddRectFilled(bb.Min, bb.Max, IM_COL32(255, 255, 255, (int)(8 * hv)), 9.0f);
        const ImVec4 fg = anim::LerpColor(anim::LerpColor(c.textDim, c.text, hv), c.text, sel);
        DrawIcon(dl, icon, ImVec2(bb.Min.x + 22.0f, bb.GetCenter().y), 17.0f, theme::Col(anim::LerpColor(fg, c.accent, sel)), 1.6f);
        if (label_alpha > 0.02f)
        {
            const ImVec2 ts = TextSize(f.medium, theme::kLabel, label);
            dl->PushClipRect(bb.Min, bb.Max, true);
            TextAt(dl, f.medium, theme::kLabel, ImVec2(bb.Min.x + 42.0f, bb.GetCenter().y - ts.y * 0.5f), theme::Col(fg, label_alpha), label);
            dl->PopClipRect();
        }
        return pressed;
    }

    // ------------------------------------------------------------------------
    // Buttons
    // ------------------------------------------------------------------------
    bool Button(const char* label, bool primary, const ImVec2& size_arg, bool enabled)
    {
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const theme::Fonts& f = theme::Font();
        const std::string text = VisibleText(label);
        const ImVec2 ts = TextSize(f.semibold, theme::kLabel, text.c_str());
        const ImVec2 size(size_arg.x > 0 ? size_arg.x : ts.x + 36.0f, size_arg.y > 0 ? size_arg.y : 38.0f);
        const ImVec2 pos = window->DC.CursorPos;
        const ImRect bb(pos, ImVec2(pos.x + size.x, pos.y + size.y));
        ImGui::ItemSize(bb);
        if (!ImGui::ItemAdd(bb, id, nullptr, enabled ? 0 : ImGuiItemFlags_Disabled))
            return false;
        bool hovered, held;
        bool pressed = ImGui::ButtonBehavior(bb, id, &hovered, &held, enabled ? 0 : ImGuiButtonFlags_None);
        if (!enabled)
            pressed = hovered = held = false;
        STUDIO_WIDGET(primary ? "button_primary" : "button");
        STUDIO_LABEL(label);
        STUDIO_STATE("enabled", enabled);

        const float hv = Animate(id, 0, hovered ? 1.0f : 0.0f, 0.12f);
        const float pr = Animate(id, 1, held ? 1.0f : 0.0f, 0.06f);
        const float en = Animate(id, 2, enabled ? 1.0f : 0.0f, 0.2f);
        const theme::Palette& c = theme::Colors();
        ImDrawList* dl = window->DrawList;
        const float inset = pr * 1.0f;
        const ImVec2 min(bb.Min.x + inset, bb.Min.y + inset);
        const ImVec2 max(bb.Max.x - inset, bb.Max.y - inset);
        const float alpha = 0.45f + 0.55f * en;
        if (primary)
        {
            if (hv > 0.01f)
                SoftShadow(dl, min, max, 10.0f, 10.0f, theme::Col(c.accent, 0.9f * hv * en));
            ImVec4 fill = c.accent;
            fill = anim::LerpColor(fill, ImVec4(1, 1, 1, 1), 0.08f * hv);
            fill = anim::LerpColor(fill, ImVec4(0, 0, 0, 1), 0.10f * pr);
            dl->AddRectFilled(min, max, theme::Col(fill, alpha), 10.0f);
            dl->AddLine(ImVec2(min.x + 10.0f, min.y + 1.0f), ImVec2(max.x - 10.0f, min.y + 1.0f), IM_COL32(255, 255, 255, (int)(50 * en)), 1.0f);
            TextAt(dl, f.semibold, theme::kLabel, ImVec2(bb.GetCenter().x - ts.x * 0.5f, bb.GetCenter().y - ts.y * 0.5f), IM_COL32(255, 255, 255, (int)(255 * alpha)), text.c_str());
        }
        else
        {
            dl->AddRectFilled(min, max, theme::Col(anim::LerpColor(ImVec4(c.control.x, c.control.y, c.control.z, 0.0f), c.control, hv)), 10.0f);
            dl->AddRect(min, max, theme::Col(anim::LerpColor(c.cardBorder, c.controlHover, hv)), 10.0f, 0, 1.0f);
            TextAt(dl, f.semibold, theme::kLabel, ImVec2(bb.GetCenter().x - ts.x * 0.5f, bb.GetCenter().y - ts.y * 0.5f), theme::Col(anim::LerpColor(c.textDim, c.text, hv), alpha), text.c_str());
        }
        return pressed;
    }

    // ------------------------------------------------------------------------
    // Search field: a pill-shaped InputTextWithHint with an icon and clear button.
    // ------------------------------------------------------------------------
    bool SearchField(const char* id, char* buf, int buf_size, float width)
    {
        const theme::Palette& c = theme::Colors();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 p = ImGui::GetCursorScreenPos();
        const float h = 36.0f;
        const ImGuiID aid = ImGui::GetID(id);
        const float focus = Animate(aid, 0, anim::Get(aid, 5, 0.0f), 0.14f);
        dl->AddRectFilled(p, ImVec2(p.x + width, p.y + h), theme::Col(c.control), h * 0.5f);
        dl->AddRect(p, ImVec2(p.x + width, p.y + h), theme::Col(anim::LerpColor(c.cardBorder, c.accent, focus)), h * 0.5f, 0, 1.0f + 0.5f * focus);
        DrawIcon(dl, Icon::Search, ImVec2(p.x + 20.0f, p.y + h * 0.5f), 14.0f, theme::Col(anim::LerpColor(c.textFaint, c.text, focus)), 1.6f);

        ImGui::SetCursorScreenPos(ImVec2(p.x + 34.0f, p.y));
        ImGui::PushStyleColor(ImGuiCol_FrameBg, ImVec4(0, 0, 0, 0));
        ImGui::PushStyleColor(ImGuiCol_FrameBgHovered, ImVec4(0, 0, 0, 0));
        ImGui::PushStyleColor(ImGuiCol_FrameBgActive, ImVec4(0, 0, 0, 0));
        ImGui::PushStyleColor(ImGuiCol_TextDisabled, c.textFaint);
        ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(4.0f, (h - theme::kBody) * 0.5f));
        ImGui::SetNextItemWidth(width - 34.0f - (buf[0] ? 34.0f : 12.0f));
        const bool changed = ImGui::InputTextWithHint(id, "Search settings...", buf, (size_t)buf_size);
        anim::Set(aid, 5, ImGui::IsItemActive() ? 1.0f : 0.0f);
        STUDIO_WIDGET("search");
        STUDIO_BIND_TEXT(buf, buf_size);
        ImGui::PopStyleVar();
        ImGui::PopStyleColor(4);

        bool cleared = false;
        if (buf[0])
        {
            ImGui::SetCursorScreenPos(ImVec2(p.x + width - 32.0f, p.y + 6.0f));
            if (ImGui::InvisibleButton("##clear_search", ImVec2(24.0f, 24.0f)))
            {
                buf[0] = 0;
                cleared = true;
            }
            const bool ch = ImGui::IsItemHovered();
            dl->AddCircleFilled(ImVec2(p.x + width - 20.0f, p.y + h * 0.5f), 9.0f, theme::Col(ch ? c.controlHover : c.card), 16);
            DrawIcon(dl, Icon::Close, ImVec2(p.x + width - 20.0f, p.y + h * 0.5f), 8.0f, theme::Col(c.textDim), 1.5f);
        }
        ImGui::SetCursorScreenPos(ImVec2(p.x, p.y + h));
        ImGui::Dummy(ImVec2(width, 0.0f));
        return changed || cleared;
    }

    // ------------------------------------------------------------------------
    // Sparkline with a vertical gradient fill (custom vertices).
    // ------------------------------------------------------------------------
    void Sparkline(const char* id, const float* values, int count, float v_min, float v_max, const ImVec2& size)
    {
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems || count < 2)
            return;
        const ImVec2 pos = window->DC.CursorPos;
        const ImRect bb(pos, ImVec2(pos.x + size.x, pos.y + size.y));
        ImGui::ItemSize(bb);
        if (!ImGui::ItemAdd(bb, window->GetID(id)))
            return;
        STUDIO_WIDGET("chart");
        STUDIO_LABEL(id);
        STUDIO_STATE("last", values[count - 1]);

        const theme::Palette& c = theme::Colors();
        ImDrawList* dl = window->DrawList;
        for (int i = 1; i <= 3; i++)
        {
            const float y = bb.Min.y + bb.GetHeight() * i / 4.0f;
            dl->AddLine(ImVec2(bb.Min.x, y), ImVec2(bb.Max.x, y), theme::Col(c.divider), 1.0f);
        }

        ImVector<ImVec2> pts;
        pts.resize(count);
        for (int i = 0; i < count; i++)
        {
            const float t = ImClamp((values[i] - v_min) / (v_max - v_min), 0.0f, 1.0f);
            pts[i] = ImVec2(bb.Min.x + bb.GetWidth() * i / (count - 1), bb.Max.y - 2.0f - (bb.GetHeight() - 6.0f) * t);
        }
        const ImU32 top = theme::Col(c.accent, 0.38f);
        const ImU32 bottom = theme::Col(c.accent, 0.0f);
        const ImVec2 uv = ImGui::GetFontTexUvWhitePixel();
        for (int i = 0; i < count - 1; i++)
        {
            dl->PrimReserve(6, 4);
            const ImDrawIdx idx = (ImDrawIdx)dl->_VtxCurrentIdx;
            dl->PrimWriteIdx(idx);
            dl->PrimWriteIdx((ImDrawIdx)(idx + 1));
            dl->PrimWriteIdx((ImDrawIdx)(idx + 2));
            dl->PrimWriteIdx(idx);
            dl->PrimWriteIdx((ImDrawIdx)(idx + 2));
            dl->PrimWriteIdx((ImDrawIdx)(idx + 3));
            dl->PrimWriteVtx(pts[i], uv, top);
            dl->PrimWriteVtx(pts[i + 1], uv, top);
            dl->PrimWriteVtx(ImVec2(pts[i + 1].x, bb.Max.y), uv, bottom);
            dl->PrimWriteVtx(ImVec2(pts[i].x, bb.Max.y), uv, bottom);
        }
        dl->AddPolyline(pts.Data, count, theme::Col(c.accent), 0, 2.0f);
        const ImVec2 last = pts[count - 1];
        dl->AddCircleFilled(last, 7.0f, theme::Col(c.accent, 0.25f), 16);
        dl->AddCircleFilled(last, 3.5f, IM_COL32(255, 255, 255, 255), 16);
    }

    // ------------------------------------------------------------------------
    // Toast notifications
    // ------------------------------------------------------------------------
    struct Toast
    {
        std::string title;
        std::string message;
        float age = 0.0f;
    };
    static std::vector<Toast> g_Toasts;
    static const float kToastLife = 3.4f;

    void PushToast(const char* title, const char* message)
    {
        g_Toasts.push_back({ title, message, 0.0f });
        if (g_Toasts.size() > 3)
            g_Toasts.erase(g_Toasts.begin());
    }

    void RenderToasts(const ImVec2& anchor)
    {
        const float dt = ImGui::GetIO().DeltaTime;
        for (size_t i = 0; i < g_Toasts.size();)
        {
            g_Toasts[i].age += dt;
            if (g_Toasts[i].age > kToastLife)
                g_Toasts.erase(g_Toasts.begin() + (long)i);
            else
                i++;
        }
        if (g_Toasts.empty())
            return;

        const ImGuiViewport* vp = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(vp->Pos);
        ImGui::SetNextWindowSize(vp->Size);
        ImGui::Begin("##toasts", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav | ImGuiWindowFlags_NoBringToFrontOnFocus);
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        float y = anchor.y;
        for (int i = (int)g_Toasts.size() - 1; i >= 0; i--)
        {
            const Toast& t = g_Toasts[i];
            const float in = anim::EaseOutBack(ImClamp(t.age / ImMax(Motion(0.35f), 1e-4f), 0.0f, 1.0f), 1.1f);
            const float out = ImClamp((kToastLife - t.age) / 0.3f, 0.0f, 1.0f);
            const float alpha = ImMin(ImClamp(t.age / 0.15f, 0.0f, 1.0f), out);
            const ImVec2 size(300.0f, 66.0f);
            const float x = anchor.x - size.x + (1.0f - in) * 40.0f;
            const ImVec2 min(x, y - size.y);
            const ImVec2 max(x + size.x, y);
            SoftShadow(dl, min, max, 12.0f, 16.0f, IM_COL32(0, 0, 0, (int)(220 * alpha)));
            dl->AddRectFilled(min, max, theme::Col(ImVec4(0.105f, 0.118f, 0.153f, 1.0f), alpha), 12.0f);
            dl->AddRect(min, max, theme::Col(c.cardBorder, alpha), 12.0f, 0, 1.0f);
            const ImVec2 ic(min.x + 30.0f, min.y + size.y * 0.5f - 2.0f);
            dl->AddCircleFilled(ic, 14.0f, theme::Col(c.success, 0.16f * alpha), 24);
            DrawIcon(dl, Icon::Check, ic, 13.0f, theme::Col(c.success, alpha), 2.2f);
            TextAt(dl, f.semibold, theme::kLabel, ImVec2(min.x + 54.0f, min.y + 13.0f), theme::Col(c.text, alpha), t.title.c_str());
            TextAt(dl, f.regular, theme::kSmall, ImVec2(min.x + 54.0f, min.y + 33.0f), theme::Col(c.textDim, alpha), t.message.c_str());
            const float life = 1.0f - t.age / kToastLife;
            dl->AddRectFilled(ImVec2(min.x + 12.0f, max.y - 4.0f), ImVec2(min.x + 12.0f + (size.x - 24.0f) * life, max.y - 2.0f), theme::Col(c.accent, 0.8f * alpha), 2.0f);
            if (i == (int)g_Toasts.size() - 1)
            {
                STUDIO_REGION("toast", min, max);
                STUDIO_STATE("age", t.age);
            }
            y -= size.y + 10.0f;
        }
        ImGui::End();
    }
}
