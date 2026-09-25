#define IMGUI_DEFINE_MATH_OPERATORS
#include "ui.h"
#include "theme.h"
#include "studio.h"
#include "imgui_internal.h"
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <cstring>

using namespace theme;

namespace ui
{
    namespace
    {
        ImGuiStorage g_anim;
        ImGuiStorage g_store;          // picker HSV state
        bool         g_first_row = true;
        ImGuiID      g_listen_id = 0;  // keybind currently capturing input

        float S() { return M().scale; }

        ImRect RowRect(float h)
        {
            ImGuiWindow* win = ImGui::GetCurrentWindow();
            const ImVec2 p = win->DC.CursorPos;
            const ImRect bb(p, ImVec2(p.x + ImGui::GetContentRegionAvail().x, p.y + h));
            ImGui::ItemSize(bb);
            if (!g_first_row)
                win->DrawList->AddLine(ImVec2(bb.Min.x, bb.Min.y + 0.5f), ImVec2(bb.Max.x, bb.Min.y + 0.5f), Col(P().divider));
            g_first_row = false;
            return bb;
        }

        void RowLabel(ImDrawList* dl, const ImRect& bb, const char* label, float hover)
        {
            const ImVec4 c = Mix(P().text_secondary, P().text_primary, hover);
            TextV(dl, T().regular, T().body, bb.Min.x, bb.Min.y, bb.Max.y, Col(c), label);
        }

        // ---- Popup shell ------------------------------------------------
        // Opens below `anchor` (left- or right-aligned); flips above when it would leave the viewport.
        bool BeginPopupShell(ImGuiID popup_id, const ImRect& anchor, float width, bool align_right)
        {
            if (!ImGui::IsPopupOpen(popup_id, ImGuiPopupFlags_None))
                return false;
            const float a = Animate(popup_id, 1.0f, 0.14f);
            const float gap = 4.0f * S();
            char name[20];
            ImFormatString(name, IM_COUNTOF(name), "##Popup_%08x", popup_id);
            const ImGuiWindow* prev = ImGui::FindWindowByName(name);
            const float h = prev ? prev->Size.y : 0.0f;
            const ImGuiViewport* vp = ImGui::GetMainViewport();
            const bool above = anchor.Max.y + gap + h > vp->WorkPos.y + vp->WorkSize.y - gap && anchor.Min.y - gap - h > vp->WorkPos.y;
            const float dir = above ? -1.0f : 1.0f;
            ImVec2 pos(align_right ? anchor.Max.x - width : anchor.Min.x, above ? anchor.Min.y - gap - h : anchor.Max.y + gap);
            pos.y -= dir * (1.0f - a) * 4.0f * S();
            ImGui::SetNextWindowPos(pos);
            ImGui::SetNextWindowSize(ImVec2(width, 0.0f));
            ImGui::PushStyleVar(ImGuiStyleVar_Alpha, ImGui::GetStyle().Alpha * a);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(4.0f * S(), 4.0f * S()));
            ImGui::PushStyleVar(ImGuiStyleVar_PopupRounding, M().radius_lg);
            ImGui::PushStyleColor(ImGuiCol_PopupBg, P().bg_panel_alt);
            ImGui::PushStyleColor(ImGuiCol_Border, P().border_strong);
            const bool open = ImGui::BeginPopupEx(popup_id, ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoTitleBar |
                                                            ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoSavedSettings |
                                                            ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoScrollbar);
            ImGui::PopStyleColor(2);
            ImGui::PopStyleVar(2);
            if (!open)
                ImGui::PopStyleVar();
            return open;
        }

        void EndPopupShell()
        {
            ImGui::EndPopup();
            ImGui::PopStyleVar();
        }

        void OpenPopupAnimated(ImGuiID popup_id)
        {
            ImGui::OpenPopupEx(popup_id, ImGuiPopupFlags_None);
            AnimateSet(popup_id, 0.0f);
        }

        bool PopupRow(const char* text, bool selected)
        {
            const float h = 28.0f * S();
            const ImVec2 p = ImGui::GetCursorScreenPos();
            const float w = ImGui::GetContentRegionAvail().x;
            ImGui::PushID(text);
            const bool pressed = ImGui::InvisibleButton("##row", ImVec2(w, h));
            STUDIO_WIDGET("option");
            STUDIO_LABEL(text);
            const bool hovered = ImGui::IsItemHovered();
            const float hv = Animate(ImGui::GetItemID(), hovered ? 1.0f : 0.0f, 0.10f);
            ImGui::PopID();

            ImDrawList* dl = ImGui::GetWindowDrawList();
            const ImVec2 q(p.x + w, p.y + h);
            if (selected)
                dl->AddRectFilled(p, q, Col(P().accent, 0.14f + 0.06f * hv), M().radius_md);
            else if (hv > 0.001f)
                dl->AddRectFilled(p, q, Col(P().bg_control_hi, hv), M().radius_md);

            const ImVec4 tc = selected ? P().text_primary : Mix(P().text_secondary, P().text_primary, hv);
            TextV(dl, T().regular, T().value, p.x + 10.0f * S(), p.y, q.y, Col(tc), text);
            if (selected)
                DrawIcon(dl, Icon::Check, ImVec2(q.x - 14.0f * S(), p.y + h * 0.5f), M().icon * 0.85f, Col(P().accent_hover), M().stroke);
            return pressed;
        }

        // ---- Combo field (shared by the row and standalone variants) -----
        bool ComboField(const char* label, int* current, const char* const items[], int count, const ImRect& r, const char* prefix)
        {
            const ImGuiID id = ImGui::GetID(label);
            if (!ImGui::ItemAdd(r, id))
                return false;
            STUDIO_WIDGET("combo");
            STUDIO_LABEL(label);
            STUDIO_BIND(current);

            bool hovered, held;
            const bool pressed = ImGui::ButtonBehavior(r, id, &hovered, &held);
            const ImGuiID popup_id = ImHashStr("##combo_popup", 0, id);
            bool open = ImGui::IsPopupOpen(popup_id, ImGuiPopupFlags_None);
            if (pressed && !open)
            {
                OpenPopupAnimated(popup_id);
                open = true;
            }
            const float hv = Animate(id, hovered || open ? 1.0f : 0.0f, 0.10f);
            const float ot = Animate(id + 1, open ? 1.0f : 0.0f, 0.16f);
            STUDIO_STATE("open", open);
            STUDIO_STATE("anim", ot);

            ImDrawList* dl = ImGui::GetWindowDrawList();
            const float s = S();
            dl->AddRectFilled(r.Min, r.Max, Col(Mix(P().bg_control, P().bg_control_hi, hv)), M().radius_md);
            const ImVec4 border = Mix(Mix(P().border_subtle, P().border_strong, hv), WithAlpha(P().accent, 0.55f), ot);
            dl->AddRect(r.Min + ImVec2(0.5f, 0.5f), r.Max - ImVec2(0.5f, 0.5f), Col(border), M().radius_md);

            float x = r.Min.x + 10.0f * s;
            if (prefix)
            {
                TextV(dl, T().regular, T().value, x, r.Min.y, r.Max.y, Col(P().text_dim), prefix);
                x += Measure(T().regular, T().value, prefix).x + 6.0f * s;
            }
            const char* value = (*current >= 0 && *current < count) ? items[*current] : "";
            dl->PushClipRect(r.Min, ImVec2(r.Max.x - 24.0f * s, r.Max.y), true);
            TextV(dl, T().medium, T().value, x, r.Min.y, r.Max.y, Col(Mix(P().text_secondary, P().text_primary, hv)), value);
            dl->PopClipRect();
            DrawChevron(dl, ImVec2(r.Max.x - 13.0f * s, (r.Min.y + r.Max.y) * 0.5f), M().icon * 0.8f,
                        Col(Mix(P().text_muted, P().text_secondary, hv)), M().stroke, ot);

            bool changed = false;
            if (BeginPopupShell(popup_id, r, r.GetWidth(), false))
            {
                for (int i = 0; i < count; i++)
                    if (PopupRow(items[i], i == *current))
                    {
                        changed = (*current != i);
                        *current = i;
                        ImGui::CloseCurrentPopup();
                    }
                EndPopupShell();
            }
            return changed;
        }

        // ---- Slider core -------------------------------------------------
        struct SliderGeom
        {
            ImRect bb;
            ImGuiID id;
            float track_y, x0, x1;
            bool hovered, held;
        };

        SliderGeom SliderBegin(const char* label, float* t, int intervals)
        {
            SliderGeom g;
            g.bb = RowRect(M().slider_row_h);
            g.id = ImGui::GetID(label);
            const float s = S();
            g.track_y = g.bb.Min.y + 36.0f * s;
            g.x0 = g.bb.Min.x;
            g.x1 = g.bb.Max.x;
            const ImRect hit(ImVec2(g.x0 - 4.0f * s, g.track_y - 10.0f * s), ImVec2(g.x1 + 4.0f * s, g.track_y + 10.0f * s));
            ImGui::ItemAdd(hit, g.id);
            ImGui::ButtonBehavior(hit, g.id, &g.hovered, &g.held, ImGuiButtonFlags_PressedOnClick);
            if (g.held)
            {
                const float r = M().knob_r;
                float nt = ImSaturate((ImGui::GetIO().MousePos.x - (g.x0 + r)) / ((g.x1 - r) - (g.x0 + r)));
                if (intervals > 0)
                    nt = std::round(nt * intervals) / intervals;
                if (nt != *t)
                {
                    *t = nt;
                    ImGui::MarkItemEdited(g.id);
                }
            }
            return g;
        }

        void SliderDraw(const SliderGeom& g, const char* label, float t, const char* value_text, int ticks)
        {
            ImDrawList* dl = ImGui::GetWindowDrawList();
            const float s = S();
            const float hv = Animate(g.id, g.hovered || g.held ? 1.0f : 0.0f, 0.10f);
            const float act = Animate(g.id + 1, g.held ? 1.0f : 0.0f, 0.12f);
            float vt;
            if (g.held && ticks == 0)
            {
                AnimateSet(g.id + 2, t);
                vt = t;
            }
            else
                vt = Animate(g.id + 2, t, 0.12f);
            STUDIO_STATE("anim", vt);

            const float label_cy = g.bb.Min.y + 16.0f * s;
            RowLabel(dl, ImRect(g.bb.Min.x, label_cy - 8 * s, g.bb.Max.x, label_cy + 8 * s), label, hv * 0.5f);
            const ImVec2 vs = Measure(T().medium, T().value, value_text);
            TextV(dl, T().medium, T().value, g.bb.Max.x - vs.x, label_cy - 8 * s, label_cy + 8 * s,
                  Col(Mix(P().text_muted, P().text_primary, ImMax(act, hv * 0.4f))), value_text);

            const float r = M().knob_r;
            const float th = M().track_h * 0.5f;
            const float kx = g.x0 + r + vt * ((g.x1 - r) - (g.x0 + r));
            dl->AddRectFilled(ImVec2(g.x0, g.track_y - th), ImVec2(g.x1, g.track_y + th), Col(Mix(Hex(0x23252F), Hex(0x2A2C38), hv)), th);
            dl->AddRectFilled(ImVec2(g.x0, g.track_y - th), ImVec2(kx, g.track_y + th), Col(Mix(P().accent, P().accent_hover, hv)), th);
            if (ticks > 0)
                for (int i = 1; i < ticks; i++)
                {
                    const float x = g.x0 + r + (float)i / ticks * ((g.x1 - r) - (g.x0 + r));
                    const bool filled = x < kx;
                    dl->AddCircleFilled(ImVec2(x, g.track_y), 1.2f * s, filled ? Col(P().on_accent, 0.45f) : Col(P().text_dim, 0.9f), 8);
                }
            if (act > 0.001f)
                dl->AddCircleFilled(ImVec2(kx, g.track_y), r + 5.0f * s, Col(P().accent, 0.18f * act), 24);
            dl->AddCircleFilled(ImVec2(kx, g.track_y), r + hv * 0.75f * s, Col(P().text_primary), 24);
        }

        // ---- Colour picker popup ----------------------------------------
        bool ColourPicker(ImGuiID popup_id, ImVec4* col)
        {
            const float s = S();
            float* hsv = g_store.GetFloatRef(popup_id + 1, -1.0f);
            float h = g_store.GetFloat(popup_id + 1), sat = g_store.GetFloat(popup_id + 2), val = g_store.GetFloat(popup_id + 3);
            if (*hsv < 0.0f)
                ImGui::ColorConvertRGBtoHSV(col->x, col->y, col->z, h, sat, val);
            bool changed = false;

            ImDrawList* dl = ImGui::GetWindowDrawList();
            const float w = ImGui::GetContentRegionAvail().x;
            const float pad = 6.0f * s;
            ImGui::Dummy(ImVec2(w, pad));

            // Saturation / value plane
            ImVec2 p = ImGui::GetCursorScreenPos() + ImVec2(pad, 0);
            const ImVec2 sv(w - pad * 2.0f, 116.0f * s);
            ImGui::SetCursorScreenPos(p);
            ImGui::InvisibleButton("##sv", sv);
            STUDIO_WIDGET("colour_plane");
            if (ImGui::IsItemActive())
            {
                sat = ImSaturate((ImGui::GetIO().MousePos.x - p.x) / sv.x);
                val = 1.0f - ImSaturate((ImGui::GetIO().MousePos.y - p.y) / sv.y);
                changed = true;
            }
            float hr, hg, hb;
            ImGui::ColorConvertHSVtoRGB(h, 1, 1, hr, hg, hb);
            const ImU32 white = Col(ImVec4(1, 1, 1, 1)), hue = Col(ImVec4(hr, hg, hb, 1));
            dl->AddRectFilledMultiColor(p, p + sv, white, hue, hue, white);
            dl->AddRectFilledMultiColor(p, p + sv, Col(ImVec4(0, 0, 0, 0)), Col(ImVec4(0, 0, 0, 0)), Col(ImVec4(0, 0, 0, 1)), Col(ImVec4(0, 0, 0, 1)));
            dl->AddRect(p, p + sv, Col(ImVec4(1, 1, 1, 0.06f)), 0.0f);
            const ImVec2 k(p.x + sat * sv.x, p.y + (1.0f - val) * sv.y);
            dl->AddCircle(k, 5.0f * s, Col(ImVec4(0, 0, 0, 0.35f)), 16, 3.0f * s);
            dl->AddCircle(k, 5.0f * s, white, 16, 1.75f * s);

            // Hue strip
            ImGui::SetCursorScreenPos(ImVec2(p.x, p.y + sv.y + 10.0f * s));
            p = ImGui::GetCursorScreenPos();
            const ImVec2 hs(sv.x, 10.0f * s);
            ImGui::InvisibleButton("##hue", hs);
            STUDIO_WIDGET("hue_strip");
            if (ImGui::IsItemActive())
            {
                h = ImClamp((ImGui::GetIO().MousePos.x - p.x) / hs.x, 0.0f, 0.9999f);
                changed = true;
            }
            const ImU32 hues[7] = { IM_COL32(255, 0, 0, 255), IM_COL32(255, 255, 0, 255), IM_COL32(0, 255, 0, 255), IM_COL32(0, 255, 255, 255),
                                    IM_COL32(0, 0, 255, 255), IM_COL32(255, 0, 255, 255), IM_COL32(255, 0, 0, 255) };
            const float alpha = ImGui::GetStyle().Alpha;
            for (int i = 0; i < 6; i++)
            {
                const float xa = p.x + hs.x * i / 6.0f, xb = p.x + hs.x * (i + 1) / 6.0f;
                ImU32 a = hues[i], b = hues[i + 1];
                a = (a & 0x00FFFFFF) | ((ImU32)(alpha * 255) << 24);
                b = (b & 0x00FFFFFF) | ((ImU32)(alpha * 255) << 24);
                dl->AddRectFilledMultiColor(ImVec2(xa, p.y), ImVec2(xb, p.y + hs.y), a, b, b, a);
            }
            const ImVec2 hk(p.x + h * hs.x, p.y + hs.y * 0.5f);
            dl->AddCircleFilled(hk, 6.0f * s, Col(ImVec4(hr, hg, hb, 1)), 16);
            dl->AddCircle(hk, 6.0f * s, white, 16, 2.0f * s);

            // Preset swatches
            static const unsigned int presets[7] = { 0x6C60FF, 0x3FA7FF, 0x2FD1B5, 0x3FCF8E, 0xF2B45A, 0xFF6B6B, 0xE56BFF };
            ImGui::SetCursorScreenPos(ImVec2(p.x, p.y + hs.y + 12.0f * s));
            const float sw = 18.0f * s, gap = (sv.x - sw * 7) / 6.0f;
            for (int i = 0; i < 7; i++)
            {
                const ImVec2 q = ImGui::GetCursorScreenPos();
                ImGui::PushID(i);
                if (ImGui::InvisibleButton("##preset", ImVec2(sw, sw)))
                {
                    const ImVec4 c = Hex(presets[i]);
                    ImGui::ColorConvertRGBtoHSV(c.x, c.y, c.z, h, sat, val);
                    changed = true;
                }
                const bool hov = ImGui::IsItemHovered();
                ImGui::PopID();
                dl->AddRectFilled(q, q + ImVec2(sw, sw), Col(Hex(presets[i])), M().radius_sm);
                if (hov)
                    dl->AddRect(q - ImVec2(2, 2) * s, q + ImVec2(sw + 2 * s, sw + 2 * s), Col(P().text_muted), M().radius_sm + 2 * s, 0, 1.0f * s);
                if (i < 6)
                    ImGui::SameLine(0, gap);
            }

            // Hex readout
            ImGui::SetCursorScreenPos(ImVec2(p.x, ImGui::GetCursorScreenPos().y + 10.0f * s));
            const ImVec2 hp = ImGui::GetCursorScreenPos();
            ImGui::Dummy(ImVec2(sv.x, 26.0f * s));
            dl->AddRectFilled(hp, hp + ImVec2(sv.x, 26.0f * s), Col(P().bg_control), M().radius_md);
            char hex[16];
            std::snprintf(hex, sizeof hex, "#%02X%02X%02X", (int)(col->x * 255 + 0.5f), (int)(col->y * 255 + 0.5f), (int)(col->z * 255 + 0.5f));
            TextV(dl, T().regular, T().value, hp.x + 10 * s, hp.y, hp.y + 26 * s, Col(P().text_dim), "Hex");
            const ImVec2 hx = Measure(T().medium, T().value, hex);
            TextV(dl, T().medium, T().value, hp.x + sv.x - 10 * s - hx.x, hp.y, hp.y + 26 * s, Col(P().text_primary), hex);
            ImGui::Dummy(ImVec2(w, pad));

            if (changed)
            {
                float r, gg, b;
                ImGui::ColorConvertHSVtoRGB(h, sat, val, r, gg, b);
                *col = ImVec4(r, gg, b, col->w);
            }
            g_store.SetFloat(popup_id + 1, h);
            g_store.SetFloat(popup_id + 2, sat);
            g_store.SetFloat(popup_id + 3, val);
            return changed;
        }

        void ChordParts(ImGuiKeyChord chord, const char* parts[5], int* n)
        {
            *n = 0;
            if (chord & ImGuiMod_Ctrl)  parts[(*n)++] = "Ctrl";
            if (chord & ImGuiMod_Shift) parts[(*n)++] = "Shift";
            if (chord & ImGuiMod_Alt)   parts[(*n)++] = "Alt";
            if (chord & ImGuiMod_Super) parts[(*n)++] = "Super";
            const ImGuiKey key = (ImGuiKey)(chord & ~ImGuiMod_Mask_);
            switch (key)
            {
            case ImGuiKey_None:        break;
            case ImGuiKey_MouseMiddle: parts[(*n)++] = "Mouse 3"; break;
            case ImGuiKey_MouseX1:     parts[(*n)++] = "Mouse 4"; break;
            case ImGuiKey_MouseX2:     parts[(*n)++] = "Mouse 5"; break;
            default:                   parts[(*n)++] = ImGui::GetKeyName(key); break;
            }
        }
    }

    // ---- Motion -----------------------------------------------------------
    float Animate(ImGuiID id, float target, float duration)
    {
        float* v = g_anim.GetFloatRef(id, target);
        const float dt = ImGui::GetIO().DeltaTime;
        const float k = 1.0f - std::exp(-dt * 4.0f / ImMax(duration, 0.001f));
        *v += (target - *v) * k;
        if (std::fabs(target - *v) < 0.002f * ImMax(1.0f, std::fabs(target)))
            *v = target;
        return *v;
    }

    void  AnimateSet(ImGuiID id, float value) { g_anim.SetFloat(id, value); }
    float EaseOutCubic(float t) { t = ImSaturate(t); const float u = 1.0f - t; return 1.0f - u * u * u; }

    // ---- Text -------------------------------------------------------------
    ImVec2 Measure(ImFont* font, float size, const char* text)
    {
        return font->CalcTextSizeA(size * S(), FLT_MAX, 0.0f, text);
    }

    void Text(ImDrawList* dl, ImFont* font, float size, ImVec2 pos, ImU32 col, const char* text)
    {
        dl->AddText(font, size * S(), ImVec2(IM_ROUND(pos.x), IM_ROUND(pos.y)), col, text);
    }

    void TextV(ImDrawList* dl, ImFont* font, float size, float x, float y0, float y1, ImU32 col, const char* text)
    {
        const float h = size * S();
        Text(dl, font, size, ImVec2(x, (y0 + y1) * 0.5f - h * 0.5f - 0.5f * S()), col, text);
    }

    void SectionCaption(ImDrawList* dl, ImVec2 pos, const char* text)
    {
        Text(dl, T().semibold, T().caption, pos, Col(Mix(P().text_dim, P().text_muted, 0.6f)), text);
    }

    // ---- Structure --------------------------------------------------------
    void BeginCard(const char* id, const char* title, float width, const char* meta)
    {
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(M().card_pad, 0.0f));
        ImGui::BeginChild(id, ImVec2(width, 0.0f), ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding,
                          ImGuiWindowFlags_NoScrollWithMouse);
        ImGui::PopStyleVar();

        ImGuiWindow* win = ImGui::GetCurrentWindow();
        ImDrawList* dl = win->DrawList;
        const ImVec2 a = win->Pos, b = win->Pos + win->Size;
        STUDIO_REGION(id, a, b);
        ImRect clip(a, b);
        if (win->ParentWindow)
            clip.ClipWith(win->ParentWindow->ClipRect);
        dl->PushClipRect(clip.Min, clip.Max, false);
        dl->AddRectFilled(a, b, Col(P().bg_panel), M().radius_lg);
        dl->AddRect(a + ImVec2(0.5f, 0.5f), b - ImVec2(0.5f, 0.5f), Col(P().border_subtle), M().radius_lg);
        dl->PopClipRect();

        const float s = S();
        const float cap_y = a.y + 14.0f * s;
        SectionCaption(dl, ImVec2(a.x + M().card_pad, cap_y), title);
        if (meta)
        {
            const ImVec2 ms = Measure(T().regular, T().small, meta);
            Text(dl, T().regular, T().small, ImVec2(b.x - M().card_pad - ms.x, cap_y - 0.5f * s), Col(P().text_dim), meta);
        }
        ImGui::SetCursorPosY(34.0f * s);
        g_first_row = true;
    }

    void EndCard()
    {
        ImGui::Dummy(ImVec2(0.0f, 6.0f * S()));
        ImGui::EndChild();
    }

    void Spacing(float px) { ImGui::Dummy(ImVec2(0.0f, px * S())); }

    // ---- Rows -------------------------------------------------------------
    bool Toggle(const char* label, bool* v, const char* desc)
    {
        const ImRect bb = RowRect(desc ? M().row_desc_h : M().row_h);
        const ImGuiID id = ImGui::GetID(label);
        if (!ImGui::ItemAdd(bb, id))
            return false;
        STUDIO_WIDGET("toggle");
        STUDIO_LABEL(label);
        STUDIO_BIND(v);

        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(bb, id, &hovered, &held);
        if (pressed)
        {
            *v = !*v;
            ImGui::MarkItemEdited(id);
        }
        const float t = Animate(id, *v ? 1.0f : 0.0f, 0.15f);
        const float hv = Animate(id + 1, hovered ? 1.0f : 0.0f, 0.10f);
        STUDIO_STATE("anim", t);

        ImDrawList* dl = ImGui::GetWindowDrawList();
        const float s = S();
        const ImVec4 lc = Mix(P().text_secondary, P().text_primary, hv);
        if (desc)
        {
            const float lh = T().body * s, dh = T().small * s, gap = 3.0f * s;
            const float top = (bb.Min.y + bb.Max.y) * 0.5f - (lh + gap + dh) * 0.5f - 0.5f * s;
            Text(dl, T().regular, T().body, ImVec2(bb.Min.x, top), Col(lc), label);
            Text(dl, T().regular, T().small, ImVec2(bb.Min.x, top + lh + gap), Col(P().text_dim), desc);
        }
        else
            RowLabel(dl, bb, label, hv);

        const float w = M().toggle_w, h = M().toggle_h;
        const ImVec2 a(bb.Max.x - w, (bb.Min.y + bb.Max.y) * 0.5f - h * 0.5f);
        const ImVec2 b(a.x + w, a.y + h);
        const ImVec4 off = Mix(Hex(0x282A35), Hex(0x30323F), hv);
        const ImVec4 on = Mix(P().accent, P().accent_hover, hv);
        dl->AddRectFilled(a, b, Col(Mix(off, on, t)), h * 0.5f);
        const float kr = h * 0.5f - 2.5f * s;
        const float kx = a.x + h * 0.5f + t * (w - h);
        dl->AddCircleFilled(ImVec2(kx, a.y + h * 0.5f), kr, Col(Mix(Hex(0x8F92A3), P().on_accent, t)), 20);
        return pressed;
    }

    bool Slider(const char* label, float* v, float min, float max, const char* fmt, float step)
    {
        float t = (max > min) ? ImSaturate((*v - min) / (max - min)) : 0.0f;
        const int intervals = step > 0.0f ? (int)std::round((max - min) / step) : 0;
        SliderGeom g = SliderBegin(label, &t, intervals);
        STUDIO_WIDGET("slider");
        STUDIO_LABEL(label);
        STUDIO_BIND(v);
        const float before = *v;
        if (g.held)
            *v = min + t * (max - min);
        char buf[64];
        std::snprintf(buf, sizeof buf, fmt, *v);
        SliderDraw(g, label, (max > min) ? ImSaturate((*v - min) / (max - min)) : 0.0f, buf, intervals <= 12 ? intervals : 0);
        return *v != before;
    }

    bool SliderSteps(const char* label, int* index, int count, const char* value_text)
    {
        const int intervals = ImMax(count - 1, 1);
        float t = (float)*index / intervals;
        SliderGeom g = SliderBegin(label, &t, intervals);
        STUDIO_WIDGET("slider");
        STUDIO_LABEL(label);
        STUDIO_BIND(index);
        const int before = *index;
        if (g.held)
            *index = (int)std::round(t * intervals);
        *index = ImClamp(*index, 0, count - 1);
        SliderDraw(g, label, (float)*index / intervals, value_text, intervals);
        return *index != before;
    }

    bool Combo(const char* label, int* current, const char* const items[], int count)
    {
        const ImRect bb = RowRect(M().row_h);
        RowLabel(ImGui::GetWindowDrawList(), bb, label, 0.0f);
        const float cy = (bb.Min.y + bb.Max.y) * 0.5f;
        const ImRect r(ImVec2(bb.Max.x - M().field_w, cy - M().control_h * 0.5f), ImVec2(bb.Max.x, cy + M().control_h * 0.5f));
        return ComboField(label, current, items, count, r, nullptr);
    }

    bool ComboBox(const char* id, int* current, const char* const items[], int count, float width, const char* prefix)
    {
        ImGuiWindow* win = ImGui::GetCurrentWindow();
        const ImRect r(win->DC.CursorPos, win->DC.CursorPos + ImVec2(width, M().control_h));
        ImGui::ItemSize(r);
        return ComboField(id, current, items, count, r, prefix);
    }

    bool Segmented(const char* label, int* current, const char* const items[], int count)
    {
        const ImRect bb = RowRect(M().row_h);
        ImDrawList* dl = ImGui::GetWindowDrawList();
        RowLabel(dl, bb, label, 0.0f);
        const float s = S();

        float seg_w = 40.0f * s;
        for (int i = 0; i < count; i++)
            seg_w = ImMax(seg_w, Measure(T().medium, T().value, items[i]).x + 18.0f * s);
        const float pad = 2.0f * s;
        const float h = M().control_h;
        const float cy = (bb.Min.y + bb.Max.y) * 0.5f;
        const ImRect r(ImVec2(bb.Max.x - seg_w * count - pad * 2, cy - h * 0.5f), ImVec2(bb.Max.x, cy + h * 0.5f));

        const ImGuiID id = ImGui::GetID(label);
        if (!ImGui::ItemAdd(r, id))
            return false;
        STUDIO_WIDGET("segmented");
        STUDIO_LABEL(label);
        STUDIO_BIND(current);

        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(r, id, &hovered, &held);
        const int hover_idx = hovered ? ImClamp((int)((ImGui::GetIO().MousePos.x - r.Min.x - pad) / seg_w), 0, count - 1) : -1;
        bool changed = false;
        if (pressed && hover_idx >= 0 && hover_idx != *current)
        {
            *current = hover_idx;
            changed = true;
            ImGui::MarkItemEdited(id);
        }
        const float ix = Animate(id, (float)*current, 0.18f);
        STUDIO_STATE("anim", ix);

        dl->AddRectFilled(r.Min, r.Max, Col(P().bg_control), M().radius_md);
        dl->AddRect(r.Min + ImVec2(0.5f, 0.5f), r.Max - ImVec2(0.5f, 0.5f), Col(P().border_subtle), M().radius_md);
        const ImVec2 ia(r.Min.x + pad + ix * seg_w, r.Min.y + pad);
        const ImVec2 ib(ia.x + seg_w, r.Max.y - pad);
        dl->AddRectFilled(ia, ib, Col(P().accent, 0.22f), M().radius_md - pad);
        dl->AddRect(ia + ImVec2(0.5f, 0.5f), ib - ImVec2(0.5f, 0.5f), Col(P().accent, 0.40f), M().radius_md - pad);
        for (int i = 0; i < count; i++)
        {
            const float x0 = r.Min.x + pad + i * seg_w;
            const float sel = 1.0f - ImSaturate(std::fabs(ix - i));
            const ImVec4 base = (i == hover_idx) ? P().text_secondary : P().text_muted;
            const ImVec2 ts = Measure(T().medium, T().value, items[i]);
            TextV(dl, T().medium, T().value, x0 + (seg_w - ts.x) * 0.5f, r.Min.y, r.Max.y, Col(Mix(base, P().text_primary, sel)), items[i]);
        }
        return changed;
    }

    bool ColorField(const char* label, ImVec4* colour)
    {
        const ImRect bb = RowRect(M().row_h);
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const float s = S();
        const ImGuiID id = ImGui::GetID(label);
        const ImGuiID popup_id = ImHashStr("##picker", 0, id);
        const bool open = ImGui::IsPopupOpen(popup_id, ImGuiPopupFlags_None);

        char hex[16];
        std::snprintf(hex, sizeof hex, "#%02X%02X%02X", (int)(colour->x * 255 + 0.5f), (int)(colour->y * 255 + 0.5f), (int)(colour->z * 255 + 0.5f));
        const ImVec2 hs = Measure(T().medium, T().value, hex);
        const float sw = M().swatch;
        const float cy = (bb.Min.y + bb.Max.y) * 0.5f;
        // Hit area: hex text + swatch, padded into a field-sized target.
        const ImRect r(ImVec2(bb.Max.x - sw - 8.0f * s - hs.x - 8.0f * s, cy - M().control_h * 0.5f), ImVec2(bb.Max.x, cy + M().control_h * 0.5f));
        if (!ImGui::ItemAdd(r, id))
            return false;
        STUDIO_WIDGET("color");
        STUDIO_LABEL(label);
        STUDIO_BIND(colour);
        bool hovered, held;
        if (ImGui::ButtonBehavior(r, id, &hovered, &held) && !open)
        {
            g_store.SetFloat(popup_id + 1, -1.0f);
            OpenPopupAnimated(popup_id);
        }
        const float hv = Animate(id, hovered || open ? 1.0f : 0.0f, 0.10f);
        STUDIO_STATE("open", open);

        RowLabel(dl, bb, label, 0.0f);
        TextV(dl, T().medium, T().value, bb.Max.x - sw - 8.0f * s - hs.x, bb.Min.y, bb.Max.y, Col(Mix(P().text_muted, P().text_secondary, hv)), hex);
        const ImVec2 a(bb.Max.x - sw, cy - sw * 0.5f), b(bb.Max.x, cy + sw * 0.5f);
        if (hv > 0.001f)
            dl->AddRect(a - ImVec2(3, 3) * s, b + ImVec2(3, 3) * s, Col(P().text_muted, 0.7f * hv), M().radius_sm + 3 * s, 0, 1.0f * s);
        dl->AddRectFilled(a, b, Col(ImVec4(colour->x, colour->y, colour->z, 1.0f)), M().radius_sm);
        dl->AddRect(a, b, Col(ImVec4(1, 1, 1, 0.10f)), M().radius_sm);

        bool changed = false;
        const float pw = 212.0f * s;
        if (BeginPopupShell(popup_id, ImRect(r.Min, ImVec2(r.Max.x + 4.0f * s, r.Max.y)), pw, true))
        {
            changed = ColourPicker(popup_id, colour);
            EndPopupShell();
        }
        return changed;
    }

    void KeyChordName(ImGuiKeyChord chord, char* buf, int buf_size)
    {
        const char* parts[5];
        int n = 0;
        ChordParts(chord, parts, &n);
        buf[0] = 0;
        for (int i = 0; i < n; i++)
        {
            if (i) std::strncat(buf, " + ", buf_size - std::strlen(buf) - 1);
            std::strncat(buf, parts[i], buf_size - std::strlen(buf) - 1);
        }
        if (n == 0)
            std::snprintf(buf, buf_size, "Not set");
    }

    bool Keybind(const char* label, ImGuiKeyChord* chord)
    {
        const ImRect bb = RowRect(M().row_h);
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const float s = S();
        const ImGuiID id = ImGui::GetID(label);
        const bool listening = (g_listen_id == id);

        const char* parts[5];
        int n = 0;
        ChordParts(*chord, parts, &n);
        const float cap_h = 24.0f * s, cap_px = 8.0f * s, cap_gap = 4.0f * s;
        const char* listen_text = "Press a key...";
        float w = 0.0f;
        if (listening)
            w = Measure(T().regular, T().value, listen_text).x + cap_px * 2.0f;
        else if (n == 0)
            w = Measure(T().regular, T().value, "Not set").x + cap_px * 2.0f;
        else
            for (int i = 0; i < n; i++)
                w += Measure(T().medium, T().value, parts[i]).x + cap_px * 2.0f + (i ? cap_gap : 0.0f);
        w = ImMax(w, 64.0f * s);
        const float cy = (bb.Min.y + bb.Max.y) * 0.5f;
        const ImRect r(ImVec2(bb.Max.x - w, cy - cap_h * 0.5f), ImVec2(bb.Max.x, cy + cap_h * 0.5f));

        if (!ImGui::ItemAdd(r, id))
            return false;
        STUDIO_WIDGET("keybind");
        STUDIO_LABEL(label);
        STUDIO_BIND((int*)chord);
        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(r, id, &hovered, &held);
        bool changed = false;
        if (pressed)
            g_listen_id = listening ? 0 : id;
        else if (listening)
        {
            if (ImGui::IsMouseClicked(ImGuiMouseButton_Left) && !hovered)
                g_listen_id = 0;
            for (int k = ImGuiKey_NamedKey_BEGIN; k < ImGuiKey_NamedKey_END && g_listen_id == id; k++)
            {
                const ImGuiKey key = (ImGuiKey)k;
                if (ImGui::IsLRModKey(key) || key == ImGuiKey_MouseLeft || key == ImGuiKey_MouseRight ||
                    key == ImGuiKey_MouseWheelX || key == ImGuiKey_MouseWheelY ||
                    (key >= ImGuiKey_ReservedForModCtrl && key <= ImGuiKey_ReservedForModSuper))
                    continue;
                if (!ImGui::IsKeyPressed(key, false))
                    continue;
                if (key == ImGuiKey_Escape)
                    ;
                else if (key == ImGuiKey_Backspace || key == ImGuiKey_Delete)
                    *chord = ImGuiKey_None, changed = true;
                else
                    *chord = key | ImGui::GetIO().KeyMods, changed = true;
                g_listen_id = 0;
            }
        }
        const bool now_listening = (g_listen_id == id);
        const float hv = Animate(id, hovered ? 1.0f : 0.0f, 0.10f);
        const float lt = Animate(id + 1, now_listening ? 1.0f : 0.0f, 0.14f);
        STUDIO_STATE("listening", now_listening);
        STUDIO_STATE("anim", lt);
        if (changed)
            ImGui::MarkItemEdited(id);

        RowLabel(dl, bb, label, hv * 0.5f);
        if (listening)
        {
            dl->AddRectFilled(r.Min, r.Max, Col(P().accent, 0.10f + 0.04f * lt), M().radius_md);
            dl->AddRect(r.Min + ImVec2(0.5f, 0.5f), r.Max - ImVec2(0.5f, 0.5f), Col(P().accent, 0.35f + 0.35f * lt), M().radius_md);
            TextV(dl, T().regular, T().value, r.Min.x + cap_px, r.Min.y, r.Max.y, Col(P().text_secondary), listen_text);
        }
        else
        {
            const ImVec4 fill = Mix(P().bg_control, P().bg_control_hi, hv);
            const ImVec4 border = Mix(P().border_subtle, P().border_strong, hv);
            if (n == 0)
            {
                dl->AddRect(r.Min + ImVec2(0.5f, 0.5f), r.Max - ImVec2(0.5f, 0.5f), Col(border), M().radius_md);
                TextV(dl, T().regular, T().value, r.Min.x + cap_px, r.Min.y, r.Max.y, Col(P().text_dim), "Not set");
            }
            float total = 0.0f;
            for (int i = 0; i < n; i++)
                total += Measure(T().medium, T().value, parts[i]).x + cap_px * 2.0f + (i ? cap_gap : 0.0f);
            float x = r.Max.x - total;
            for (int i = 0; i < n; i++)
            {
                const float cw = Measure(T().medium, T().value, parts[i]).x + cap_px * 2.0f;
                const ImVec2 a(x, r.Min.y), b(x + cw, r.Max.y);
                dl->AddRectFilled(a, b, Col(fill), M().radius_sm + 1.0f * s);
                dl->AddRect(a + ImVec2(0.5f, 0.5f), b - ImVec2(0.5f, 0.5f), Col(border), M().radius_sm + 1.0f * s);
                dl->AddLine(ImVec2(a.x + 3 * s, b.y - 0.5f), ImVec2(b.x - 3 * s, b.y - 0.5f), Col(border, 1.0f), 1.0f);
                TextV(dl, T().medium, T().value, a.x + cap_px, a.y, b.y, Col(Mix(P().text_secondary, P().text_primary, hv)), parts[i]);
                x += cw + cap_gap;
            }
        }
        return changed;
    }

    bool PathField(const char* label, const char* path)
    {
        const ImRect bb = RowRect(M().row_h);
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const float s = S();
        RowLabel(dl, bb, label, 0.0f);
        const float cy = (bb.Min.y + bb.Max.y) * 0.5f;
        const float fw = ImMax(M().field_w, bb.GetWidth() - Measure(T().regular, T().body, label).x - M().gap_xxl);
        const ImRect r(ImVec2(bb.Max.x - fw, cy - M().control_h * 0.5f), ImVec2(bb.Max.x, cy + M().control_h * 0.5f));
        const ImGuiID id = ImGui::GetID(label);
        if (!ImGui::ItemAdd(r, id))
            return false;
        STUDIO_WIDGET("path");
        STUDIO_LABEL(label);
        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(r, id, &hovered, &held);
        const float hv = Animate(id, hovered ? 1.0f : 0.0f, 0.10f);

        dl->AddRectFilled(r.Min, r.Max, Col(Mix(P().bg_control, P().bg_control_hi, hv)), M().radius_md);
        dl->AddRect(r.Min + ImVec2(0.5f, 0.5f), r.Max - ImVec2(0.5f, 0.5f), Col(Mix(P().border_subtle, P().border_strong, hv)), M().radius_md);
        DrawIcon(dl, Icon::Folder, ImVec2(r.Min.x + 16.0f * s, cy), M().icon * 0.85f, Col(Mix(P().text_muted, P().accent_hover, hv)), M().stroke);
        const float tx = r.Min.x + 30.0f * s;
        const float clip_x = r.Max.x - 10.0f * s;
        dl->PushClipRect(ImVec2(tx, r.Min.y), ImVec2(clip_x, r.Max.y), true);
        TextV(dl, T().regular, T().value, tx, r.Min.y, r.Max.y, Col(Mix(P().text_secondary, P().text_primary, hv)), path);
        dl->PopClipRect();
        // Fade the clipped tail into the field.
        const ImVec4 f = Mix(P().bg_control, P().bg_control_hi, hv);
        dl->AddRectFilledMultiColor(ImVec2(clip_x - 18.0f * s, r.Min.y + 1), ImVec2(clip_x, r.Max.y - 1), Col(f, 0.0f), Col(f), Col(f), Col(f, 0.0f));
        return pressed;
    }

    void InfoRow(const char* label, const char* value, const ImVec4* dot)
    {
        const ImRect bb = RowRect(M().row_h);
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const float s = S();
        RowLabel(dl, bb, label, 0.0f);
        const ImVec2 vs = Measure(T().medium, T().value, value);
        TextV(dl, T().medium, T().value, bb.Max.x - vs.x, bb.Min.y, bb.Max.y, Col(P().text_muted), value);
        if (dot)
            dl->AddCircleFilled(ImVec2(bb.Max.x - vs.x - 9.0f * s, (bb.Min.y + bb.Max.y) * 0.5f), 3.0f * s, Col(*dot), 12);
    }

    void StatStrip(const char* id, const Stat* stats, int count)
    {
        ImGuiWindow* win = ImGui::GetCurrentWindow();
        const float s = S();
        const ImVec2 a = win->DC.CursorPos;
        const ImVec2 b(a.x + ImGui::GetContentRegionAvail().x, a.y + 58.0f * s);
        ImGui::ItemSize(ImRect(a, b));
        STUDIO_REGION(id, a, b);
        ImDrawList* dl = win->DrawList;
        dl->AddRectFilled(a, b, Col(P().bg_panel), M().radius_lg);
        dl->AddRect(a + ImVec2(0.5f, 0.5f), b - ImVec2(0.5f, 0.5f), Col(P().border_subtle), M().radius_lg);

        const float cw = (b.x - a.x) / count;
        for (int i = 0; i < count; i++)
        {
            const float x = a.x + cw * i + M().card_pad;
            if (i > 0)
                dl->AddLine(ImVec2(a.x + cw * i + 0.5f, a.y + 14.0f * s), ImVec2(a.x + cw * i + 0.5f, b.y - 14.0f * s), Col(P().divider));
            SectionCaption(dl, ImVec2(x, a.y + 12.0f * s), stats[i].label);
            float vx = x;
            if (stats[i].dot)
            {
                dl->AddCircleFilled(ImVec2(x + 3.5f * s, a.y + 38.0f * s), 3.5f * s, Col(*stats[i].dot), 12);
                dl->AddCircleFilled(ImVec2(x + 3.5f * s, a.y + 38.0f * s), 7.0f * s, Col(*stats[i].dot, 0.12f), 16);
                vx += 14.0f * s;
            }
            Text(dl, T().semibold, T().title, ImVec2(vx, a.y + 29.0f * s), Col(P().text_primary), stats[i].value);
            if (stats[i].unit)
            {
                const float vw = Measure(T().semibold, T().title, stats[i].value).x;
                Text(dl, T().regular, T().small, ImVec2(vx + vw + 4.0f * s, a.y + 32.0f * s), Col(P().text_muted), stats[i].unit);
            }
        }
    }

    // ---- Standalone -------------------------------------------------------
    bool Button(const char* label, ButtonKind kind, float height, bool enabled)
    {
        ImGuiWindow* win = ImGui::GetCurrentWindow();
        const float s = S();
        const float h = height > 0.0f ? height : M().control_h;
        const ImVec2 ts = Measure(T().medium, T().value, label);
        const ImRect r(win->DC.CursorPos, win->DC.CursorPos + ImVec2(ts.x + 28.0f * s, h));
        ImGui::ItemSize(r);
        const ImGuiID id = ImGui::GetID(label);
        if (!ImGui::ItemAdd(r, id, nullptr, enabled ? ImGuiItemFlags_None : ImGuiItemFlags_Disabled))
            return false;
        STUDIO_WIDGET("button");
        STUDIO_LABEL(label);
        bool hovered = false, held = false;
        const bool pressed = enabled && ImGui::ButtonBehavior(r, id, &hovered, &held);
        const float hv = Animate(id, hovered ? 1.0f : 0.0f, 0.10f);
        const float en = Animate(id + 1, enabled ? 1.0f : 0.0f, 0.16f);
        STUDIO_STATE("enabled", enabled);

        ImDrawList* dl = win->DrawList;
        if (kind == ButtonKind::Primary)
        {
            ImVec4 fill = Mix(P().accent, P().accent_hover, hv);
            if (held)
                fill = Mix(P().accent, ImVec4(0, 0, 0, 1), 0.12f);
            fill = Mix(Hex(0x24252F), fill, en);
            dl->AddRectFilled(r.Min, r.Max, Col(fill), M().radius_md);
            TextV(dl, T().medium, T().value, r.Min.x + 14.0f * s, r.Min.y, r.Max.y, Col(Mix(P().text_dim, P().on_accent, en)), label);
        }
        else
        {
            dl->AddRectFilled(r.Min, r.Max, Col(Mix(P().bg_control, P().bg_control_hi, hv)), M().radius_md);
            dl->AddRect(r.Min + ImVec2(0.5f, 0.5f), r.Max - ImVec2(0.5f, 0.5f), Col(Mix(P().border_subtle, P().border_strong, hv)), M().radius_md);
            const ImVec4 tc = Mix(P().text_dim, Mix(P().text_secondary, P().text_primary, hv), en);
            TextV(dl, T().medium, T().value, r.Min.x + 14.0f * s, r.Min.y, r.Max.y, Col(tc), label);
        }
        return pressed;
    }

    bool NavItem(Icon icon, const char* label, bool selected)
    {
        const float s = S();
        const ImVec2 p = ImGui::GetCursorScreenPos();
        const float w = ImGui::CalcItemWidth();
        const bool pressed = ImGui::InvisibleButton(label, ImVec2(w, M().nav_h));
        STUDIO_WIDGET("nav");
        const ImGuiID id = ImGui::GetItemID();
        const bool hovered = ImGui::IsItemHovered();
        const float hv = Animate(id, hovered && !selected ? 1.0f : 0.0f, 0.10f);
        const float st = Animate(id + 1, selected ? 1.0f : 0.0f, 0.18f);
        STUDIO_STATE("selected", selected);
        STUDIO_STATE("anim", st);

        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 q(p.x + w, p.y + M().nav_h);
        if (hv > 0.001f)
            dl->AddRectFilled(p, q, Col(ImVec4(1, 1, 1, 0.035f * hv)), M().radius_md);
        const ImVec4 ic = Mix(Mix(P().text_muted, P().text_secondary, hv), P().accent_hover, st);
        const ImVec4 tc = Mix(Mix(P().text_muted, P().text_secondary, hv), P().text_primary, st);
        DrawIcon(dl, icon, ImVec2(p.x + 20.0f * s, (p.y + q.y) * 0.5f), M().icon, Col(ic), M().stroke);
        TextV(dl, selected ? T().medium : T().regular, T().body, p.x + 38.0f * s, p.y, q.y, Col(tc), label);
        return pressed;
    }
}
