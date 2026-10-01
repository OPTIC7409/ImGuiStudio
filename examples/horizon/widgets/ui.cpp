#include "ui.h"
#include "theme.h"
#include "imgui_internal.h"
#include "studio.h"
#include <cmath>
#include <cstdio>

using namespace theme;

namespace ui
{
    namespace
    {
        struct CardState
        {
            ImVec2      min;
            float       width = 0, min_h = 0;
            bool        first_row = true;
            const char* title = nullptr;
        } g_card;
        float g_row_w = 0.0f;
        float g_last_natural_bottom = 0.0f;
        bool  g_reduced_motion = false;

        ImDrawList* DL() { return ImGui::GetWindowDrawList(); }

        // Starts a settings row: returns its origin and width, draws the divider above it.
        ImVec2 RowBegin(float* w)
        {
            ImVec2 p = ImGui::GetCursorScreenPos();
            *w = g_row_w > 0 ? g_row_w : ImGui::GetContentRegionAvail().x;
            if (!g_card.first_row)
                DL()->AddLine(ImVec2(p.x, p.y + 0.5f), ImVec2(p.x + *w, p.y + 0.5f), Col(C.divider));
            g_card.first_row = false;
            return p;
        }

        void RowLabel(ImVec2 p, float h, const char* label, float hover)
        {
            const char* end = ImGui::FindRenderedTextEnd(label);
            float y = p.y + (h - M.fs_body) * 0.5f - 1.0f;
            DL()->AddText(F.regular, M.fs_body, ImVec2(p.x, IM_ROUND(y)), Col(Mix(C.text_label, C.text, hover)), label, end);
        }

        struct PopupScope
        {
            bool open;
            PopupScope(const char* id, ImVec2 pos, float width, float t)
            {
                ImGui::SetNextWindowPos(ImVec2(pos.x, pos.y - (1.0f - t) * 4.0f * M.scale));
                if (width > 0)
                    ImGui::SetNextWindowSize(ImVec2(width, 0));
                ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(M.gap_xs, M.gap_xs));
                ImGui::PushStyleVar(ImGuiStyleVar_Alpha, ImMax(t, 0.02f));
                ImGui::PushStyleColor(ImGuiCol_PopupBg, C.bg_panel_alt);
                ImGui::PushStyleColor(ImGuiCol_Border, C.border_strong);
                open = ImGui::BeginPopup(id, ImGuiWindowFlags_NoMove);
                if (!open)
                    Pop();
            }
            void End() { ImGui::EndPopup(); Pop(); }
            void Pop() { ImGui::PopStyleVar(2); ImGui::PopStyleColor(2); }
        };

        const ImVec4 kSwatches[] = {
            Hex(0xF5A03A), Hex(0xF0605A), Hex(0xE85D9C), Hex(0xA78BFA), Hex(0x6C8CFF),
            Hex(0x38BDF8), Hex(0x3DD68C), Hex(0xB5E655), Hex(0xFACC15), Hex(0xEEF0F4),
        };

        bool SameColour(const ImVec4& a, const ImVec4& b)
        {
            return fabsf(a.x - b.x) + fabsf(a.y - b.y) + fabsf(a.z - b.z) < 0.01f;
        }

        void SwatchShape(ImDrawList* dl, ImVec2 mn, float sz, const ImVec4& c, float hover, bool ring)
        {
            ImVec2 mx(mn.x + sz, mn.y + sz);
            dl->AddRectFilled(mn, mx, Col(Alpha(c, 1.0f / ImMax(c.w, 0.001f) * c.w)), M.radius_sm);
            dl->AddRect(mn, mx, Col(ImVec4(1, 1, 1, 0.10f + 0.20f * hover)), M.radius_sm, 0, 1.0f);
            if (ring)
                dl->AddRect(ImVec2(mn.x - 3 * M.scale, mn.y - 3 * M.scale), ImVec2(mx.x + 3 * M.scale, mx.y + 3 * M.scale),
                            Col(C.text, 0.8f), M.radius_md, 0, 1.2f * M.scale);
        }

        // Small colour swatch with a custom preset-palette popup.
        bool ColourSwatch(const char* id, ImVec4* c, ImVec2 pos)
        {
            bool changed = false;
            ImGui::SetCursorScreenPos(pos);
            bool pressed = ImGui::InvisibleButton(id, ImVec2(M.swatch, M.swatch));
            STUDIO_WIDGET("color");
            STUDIO_BIND_COLOR(&c->x, 4);
            float h = Anim(ImGui::GetItemID(), ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
            SwatchShape(DL(), pos, M.swatch, *c, h, false);

            ImGui::PushID(id);
            if (pressed)
                ImGui::OpenPopup("##palette");
            float t = Anim(ImGui::GetID("##palette_t"), ImGui::IsPopupOpen("##palette") ? 1.0f : 0.0f, 22);
            const int cols = 5;
            float cell = 18 * M.scale, gap = 8 * M.scale, pad = 10 * M.scale;
            float pw = cols * cell + (cols - 1) * gap + pad * 2;
            PopupScope pop("##palette", ImVec2(pos.x + M.swatch - pw, pos.y + M.swatch + M.gap_sm), pw, t);
            if (pop.open)
            {
                ImDrawList* dl = DL();
                ImVec2 o = ImGui::GetCursorScreenPos();
                Text(F.medium, M.fs_micro, ImVec2(o.x + pad - M.gap_xs, o.y + M.gap_sm - 2), C.text_muted, "COLOUR");
                o.y += 26 * M.scale;
                for (int i = 0; i < IM_ARRAYSIZE(kSwatches); i++)
                {
                    ImVec2 cp(o.x + pad - M.gap_xs + (i % cols) * (cell + gap), o.y + (i / cols) * (cell + gap));
                    ImGui::SetCursorScreenPos(cp);
                    ImGui::PushID(i);
                    if (ImGui::InvisibleButton("##sw", ImVec2(cell, cell)))
                    {
                        float a = c->w;
                        *c = kSwatches[i];
                        c->w = a;
                        changed = true;
                    }
                    float sh = Anim(ImGui::GetItemID(), ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
                    SwatchShape(dl, cp, cell, kSwatches[i], sh, SameColour(*c, kSwatches[i]));
                    ImGui::PopID();
                }
                ImGui::Dummy(ImVec2(0, pad - M.gap_xs));
                pop.End();
            }
            ImGui::PopID();
            return changed;
        }
    }

    float Anim(ImGuiID id, float target, float speed)
    {
        static ImGuiStorage storage;
        float* v = storage.GetFloatRef(id, -1e9f);
        if (*v < -1e8f || g_reduced_motion)
            *v = target;
        *v += (target - *v) * (1.0f - expf(-speed * ImGui::GetIO().DeltaTime));
        if (fabsf(target - *v) < 0.002f)
            *v = target;
        return *v;
    }

    void SetReducedMotion(bool reduced) { g_reduced_motion = reduced; }

    ImVec2 TextSize(ImFont* font, float size, const char* text)
    {
        return font->CalcTextSizeA(size, FLT_MAX, 0.0f, text, ImGui::FindRenderedTextEnd(text));
    }

    void Text(ImFont* font, float size, ImVec2 pos, const ImVec4& col, const char* text)
    {
        DL()->AddText(font, size, ImVec2(IM_ROUND(pos.x), IM_ROUND(pos.y)), Col(col), text, ImGui::FindRenderedTextEnd(text));
    }

    void DrawChevron(ImDrawList* dl, ImVec2 c, float size, ImU32 col, float t)
    {
        float s = size * 0.5f, f = 1.0f - 2.0f * t;
        dl->PathLineTo(ImVec2(c.x - s * 0.5f, c.y - s * 0.25f * f));
        dl->PathLineTo(ImVec2(c.x, c.y + s * 0.25f * f));
        dl->PathLineTo(ImVec2(c.x + s * 0.5f, c.y - s * 0.25f * f));
        dl->PathStroke(col, 0, M.stroke);
    }

    void DrawIcon(ImDrawList* dl, Icon icon, ImVec2 c, float size, ImU32 col)
    {
        const float s = size * 0.5f, th = M.stroke;
        auto P = [&](float x, float y) { return ImVec2(c.x + x * s, c.y + y * s); };
        switch (icon)
        {
        case Icon::Crosshair:
            dl->AddCircle(c, s * 0.66f, col, 24, th);
            dl->AddLine(P(0, -1.0f), P(0, -0.38f), col, th);
            dl->AddLine(P(0, 0.38f), P(0, 1.0f), col, th);
            dl->AddLine(P(-1.0f, 0), P(-0.38f, 0), col, th);
            dl->AddLine(P(0.38f, 0), P(1.0f, 0), col, th);
            break;
        case Icon::Eye:
            dl->PathLineTo(P(-1.0f, 0));
            dl->PathBezierQuadraticCurveTo(P(0, -1.05f), P(1.0f, 0));
            dl->PathBezierQuadraticCurveTo(P(0, 1.05f), P(-1.0f, 0));
            dl->PathStroke(col, ImDrawFlags_Closed, th);
            dl->AddCircle(c, s * 0.3f, col, 16, th);
            break;
        case Icon::Shield:
            dl->PathLineTo(P(0, -1.0f));
            dl->PathLineTo(P(0.82f, -0.66f));
            dl->PathLineTo(P(0.82f, -0.05f));
            dl->PathBezierQuadraticCurveTo(P(0.74f, 0.7f), P(0, 1.0f));
            dl->PathBezierQuadraticCurveTo(P(-0.74f, 0.7f), P(-0.82f, -0.05f));
            dl->PathLineTo(P(-0.82f, -0.66f));
            dl->PathStroke(col, ImDrawFlags_Closed, th);
            break;
        case Icon::Sliders:
        {
            const float ys[3] = { -0.62f, 0.0f, 0.62f }, ks[3] = { -0.35f, 0.4f, -0.1f };
            for (int i = 0; i < 3; i++)
            {
                dl->AddLine(P(-1.0f, ys[i]), P(1.0f, ys[i]), col, th);
                dl->AddCircleFilled(P(ks[i], ys[i]), 2.4f * M.scale, col);
            }
            break;
        }
        case Icon::Folder:
            dl->PathLineTo(P(-1.0f, -0.7f));
            dl->PathLineTo(P(-0.25f, -0.7f));
            dl->PathLineTo(P(0.05f, -0.42f));
            dl->PathLineTo(P(1.0f, -0.42f));
            dl->PathLineTo(P(1.0f, 0.78f));
            dl->PathLineTo(P(-1.0f, 0.78f));
            dl->PathStroke(col, ImDrawFlags_Closed, th);
            break;
        case Icon::Check:
            dl->PathLineTo(P(-0.55f, 0.02f));
            dl->PathLineTo(P(-0.15f, 0.4f));
            dl->PathLineTo(P(0.6f, -0.42f));
            dl->PathStroke(col, 0, th);
            break;
        case Icon::Logo:
            // Stylised "V" mark inside a ring segment
            dl->PathArcTo(c, s * 0.92f, IM_PI * 0.80f, IM_PI * 2.20f, 32);
            dl->PathStroke(col, 0, th * 1.2f);
            dl->PathLineTo(P(-0.42f, -0.30f));
            dl->PathLineTo(P(0.0f, 0.42f));
            dl->PathLineTo(P(0.42f, -0.30f));
            dl->PathStroke(col, 0, th * 1.4f);
            break;
        }
    }

    // ---------------------------------------------------------------- navigation

    void NavGroup(const char* label, float width)
    {
        ImVec2 p = ImGui::GetCursorScreenPos();
        Text(F.medium, M.fs_micro, ImVec2(p.x + M.gap_md, p.y + M.gap_lg), C.text_dim, label);
        ImGui::Dummy(ImVec2(width, M.gap_lg + M.fs_micro + M.gap_sm));
    }

    bool NavItem(Icon icon, const char* label, bool selected, float width)
    {
        ImVec2 p = ImGui::GetCursorScreenPos();
        ImVec2 sz(width, M.nav_h);
        bool pressed = ImGui::InvisibleButton(label, sz);
        STUDIO_WIDGET("nav");
        ImGuiID id = ImGui::GetItemID();
        float h = Anim(id, ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
        float a = Anim(id + 1, selected ? 1.0f : 0.0f, 18);
        STUDIO_STATE("anim", a);

        ImDrawList* dl = DL();
        ImVec2 mx(p.x + sz.x, p.y + sz.y);
        float cy = p.y + sz.y * 0.5f;
        dl->AddRectFilled(p, mx, Col(Alpha(C.text, 0.035f * h * (1.0f - a))), M.radius_md);
        dl->AddRectFilled(p, mx, Col(Alpha(C.accent, 0.10f * a)), M.radius_md);
        if (a > 0.01f)
            dl->AddRectFilled(ImVec2(p.x, cy - 8 * M.scale * a), ImVec2(p.x + 2 * M.scale, cy + 8 * M.scale * a), Col(C.accent, a), 1.0f);

        ImVec4 icol = Mix(Mix(C.text_dim, C.text_muted, h), C.accent, a);
        DrawIcon(dl, icon, ImVec2(p.x + M.gap_md + 8 * M.scale, cy), 15 * M.scale, Col(icol));
        ImVec4 tcol = Mix(C.text_muted, C.text, ImMax(h * 0.7f, a));
        Text(F.medium, M.fs_body, ImVec2(p.x + 40 * M.scale, cy - M.fs_body * 0.5f - 1), tcol, label);
        return pressed;
    }

    // ---------------------------------------------------------------- cards

    void BeginCard(const char* title, float width, float min_h, const char* hint)
    {
        ImDrawList* dl = DL();
        dl->ChannelsSplit(2);
        dl->ChannelsSetCurrent(1);
        ImVec2 p = ImGui::GetCursorScreenPos();
        g_card.min = p;
        g_card.width = width;
        g_card.min_h = min_h;
        g_card.first_row = true;
        g_card.title = title;

        const float pad = M.card_pad;
        Text(F.semibold, M.fs_body, ImVec2(p.x + pad, p.y + pad), C.text, title);
        if (hint)
        {
            ImVec2 hs = TextSize(F.regular, M.fs_small, hint);
            Text(F.regular, M.fs_small, ImVec2(p.x + width - pad - hs.x, p.y + pad + 1), C.text_dim, hint);
        }
        ImGui::SetCursorScreenPos(ImVec2(p.x + pad, p.y + pad + M.card_header_h));
        ImGui::BeginGroup();
        ImGui::PushID(title);
        g_row_w = width - pad * 2;
    }

    float CardInnerWidth() { return g_row_w; }
    float LastCardNaturalBottom() { return g_last_natural_bottom; }

    void EndCard()
    {
        ImGui::PopID();
        ImGui::EndGroup();
        g_row_w = 0.0f;
        ImDrawList* dl = DL();
        ImVec2 mn = g_card.min;
        g_last_natural_bottom = ImGui::GetItemRectMax().y + M.gap_xs;
        float h = ImMax(g_last_natural_bottom - mn.y, g_card.min_h);
        ImVec2 mx(mn.x + g_card.width, mn.y + h);
        dl->ChannelsSetCurrent(0);
        dl->AddRectFilled(mn, mx, Col(C.bg_panel), M.radius_lg);
        dl->AddRect(mn, mx, Col(C.border), M.radius_lg, 0, 1.0f);
        dl->ChannelsMerge();
        STUDIO_REGION(g_card.title, mn, mx);
        ImGui::SetCursorScreenPos(mn);
        ImGui::Dummy(ImVec2(g_card.width, h));
    }

    // ---------------------------------------------------------------- rows

    bool Toggle(const char* label, bool* v, ImVec4* colour)
    {
        float w;
        ImVec2 p = RowBegin(&w);
        const float cy = p.y + M.row_h * 0.5f;
        const float tx = p.x + w - M.toggle_w;
        ImGui::PushID(label);
        bool changed = false;
        if (colour)
            changed |= ColourSwatch("##colour", colour, ImVec2(tx - M.gap_md - M.swatch, IM_ROUND(cy - M.swatch * 0.5f)));
        ImGui::PopID();

        ImGui::SetCursorScreenPos(p);
        if (ImGui::InvisibleButton(label, ImVec2(w, M.row_h)))
        {
            *v = !*v;
            changed = true;
        }
        STUDIO_WIDGET("toggle");
        STUDIO_BIND(v);
        ImGuiID id = ImGui::GetItemID();
        float h = Anim(id, ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
        float t = Anim(id + 1, *v ? 1.0f : 0.0f, 20);
        STUDIO_STATE("anim", t);

        RowLabel(p, M.row_h, label, h);
        ImDrawList* dl = DL();
        ImVec2 a(tx, cy - M.toggle_h * 0.5f), b(tx + M.toggle_w, cy + M.toggle_h * 0.5f);
        ImVec4 off = Mix(C.bg_track, C.border_strong, h);
        dl->AddRectFilled(a, b, Col(Mix(off, Mix(C.accent, C.accent_hover, h), t)), M.toggle_h * 0.5f);
        float r = M.toggle_h * 0.5f - 3 * M.scale;
        float kx = ImLerp(a.x + M.toggle_h * 0.5f, b.x - M.toggle_h * 0.5f, t);
        dl->AddCircleFilled(ImVec2(kx, cy), r, Col(Mix(Mix(C.text_muted, C.text_label, h), ImVec4(1, 1, 1, 1), t)), 20);
        return changed;
    }

    bool Slider(const char* label, float* v, float v_min, float v_max, const char* fmt)
    {
        float w;
        ImVec2 p = RowBegin(&w);
        const float ty = p.y + 35 * M.scale;
        const float hit = 16 * M.scale;
        ImGui::SetCursorScreenPos(ImVec2(p.x, ty - hit * 0.5f));
        ImGui::InvisibleButton(label, ImVec2(w, hit));
        STUDIO_WIDGET("slider");
        STUDIO_BIND(v);
        ImGuiID id = ImGui::GetItemID();
        bool active = ImGui::IsItemActive(), changed = false;
        if (active)
        {
            float f = ImClamp((ImGui::GetIO().MousePos.x - p.x) / w, 0.0f, 1.0f);
            float nv = v_min + f * (v_max - v_min);
            changed = nv != *v;
            *v = nv;
        }
        float h = Anim(id, (ImGui::IsItemHovered() || active) ? 1.0f : 0.0f, 28);
        float act = Anim(id + 1, active ? 1.0f : 0.0f, 24);
        float frac = Anim(id + 2, ImSaturate((*v - v_min) / (v_max - v_min)), 30);
        STUDIO_STATE("fill", frac);

        RowLabel(ImVec2(p.x, p.y + 6 * M.scale), 20 * M.scale, label, h);
        char buf[32];
        snprintf(buf, sizeof(buf), fmt, *v);
        ImVec2 vs = TextSize(F.medium, M.fs_body, buf);
        Text(F.medium, M.fs_body, ImVec2(p.x + w - vs.x, p.y + 8 * M.scale), Mix(C.text_muted, C.text, ImMax(h, 0.5f)), buf);

        ImDrawList* dl = DL();
        float th = 2 * M.scale, kx = p.x + w * frac;
        dl->AddRectFilled(ImVec2(p.x, ty - th), ImVec2(p.x + w, ty + th), Col(C.bg_track), th);
        dl->AddRectFilled(ImVec2(p.x, ty - th), ImVec2(ImMax(kx, p.x + th * 2), ty + th), Col(Mix(C.accent, C.accent_hover, h)), th);
        float r = (5.5f + 1.0f * h) * M.scale;
        if (act > 0.01f)
            dl->AddCircleFilled(ImVec2(kx, ty), r + 5 * M.scale * act, Col(Alpha(C.accent, 0.18f * act)), 24);
        dl->AddCircleFilled(ImVec2(kx, ty + 1), r + 1, Col(ImVec4(0, 0, 0, 0.35f)), 24);
        dl->AddCircleFilled(ImVec2(kx, ty), r, Col(C.text), 24);

        ImGui::SetCursorScreenPos(ImVec2(p.x, ty + hit * 0.5f));
        ImGui::Dummy(ImVec2(w, p.y + M.slider_row_h - (ty + hit * 0.5f)));
        return changed;
    }

    bool ComboField(const char* id, int* v, const char* const items[], int count, ImVec2 pos, float width)
    {
        bool changed = false;
        ImGui::SetCursorScreenPos(pos);
        bool pressed = ImGui::InvisibleButton(id, ImVec2(width, M.control_h));
        STUDIO_WIDGET("combo");
        STUDIO_BIND(v);
        ImGuiID iid = ImGui::GetItemID();
        float h = Anim(iid, ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);

        ImGui::PushID(id);
        if (pressed)
            ImGui::OpenPopup("##list");
        bool is_open = ImGui::IsPopupOpen("##list");
        float t = Anim(iid + 1, is_open ? 1.0f : 0.0f, 22);
        STUDIO_STATE("open", t);

        ImDrawList* dl = DL();
        ImVec2 mx(pos.x + width, pos.y + M.control_h);
        dl->AddRectFilled(pos, mx, Col(Mix(C.bg_control, C.bg_control_hi, h)), M.radius_md);
        dl->AddRect(pos, mx, Col(Mix(C.border, Alpha(C.accent, 0.55f), t)), M.radius_md, 0, 1.0f);
        float ty = pos.y + (M.control_h - M.fs_body) * 0.5f - 1;
        Text(F.regular, M.fs_body, ImVec2(pos.x + 10 * M.scale, ty), Mix(C.text_label, C.text, h), items[*v]);
        DrawChevron(dl, ImVec2(mx.x - 13 * M.scale, pos.y + M.control_h * 0.5f), 12 * M.scale,
                    Col(Mix(C.text_muted, C.text_label, h)), t);

        float pw = width;
        for (int i = 0; i < count; i++)
            pw = ImMax(pw, TextSize(F.regular, M.fs_body, items[i]).x + 44 * M.scale);
        PopupScope pop("##list", ImVec2(mx.x - pw, mx.y + M.gap_xs), pw, t);
        if (pop.open)
        {
            float iw = pw - M.gap_xs * 2, ih = 28 * M.scale;
            for (int i = 0; i < count; i++)
            {
                ImGui::PushID(i);
                ImVec2 ip = ImGui::GetCursorScreenPos();
                if (ImGui::InvisibleButton("##item", ImVec2(iw, ih)))
                {
                    changed = *v != i;
                    *v = i;
                    ImGui::CloseCurrentPopup();
                }
                float ih_t = Anim(ImGui::GetItemID(), ImGui::IsItemHovered() ? 1.0f : 0.0f, 30);
                bool sel = *v == i;
                ImDrawList* pdl = DL();
                ImVec2 imx(ip.x + iw, ip.y + ih);
                if (sel)
                    pdl->AddRectFilled(ip, imx, Col(Alpha(C.accent, 0.10f)), M.radius_sm);
                pdl->AddRectFilled(ip, imx, Col(Alpha(C.text, 0.045f * ih_t)), M.radius_sm);
                ImVec4 tc = sel ? C.accent : Mix(C.text_label, C.text, ih_t);
                Text(F.regular, M.fs_body, ImVec2(ip.x + 8 * M.scale, ip.y + (ih - M.fs_body) * 0.5f - 1), tc, items[i]);
                if (sel)
                    DrawIcon(pdl, Icon::Check, ImVec2(imx.x - 14 * M.scale, ip.y + ih * 0.5f), 12 * M.scale, Col(C.accent));
                ImGui::PopID();
            }
            pop.End();
        }
        ImGui::PopID();
        return changed;
    }

    bool Combo(const char* label, int* v, const char* const items[], int count)
    {
        float w;
        ImVec2 p = RowBegin(&w);
        ImVec2 fp(p.x + w - M.combo_w, IM_ROUND(p.y + (M.row_h - M.control_h) * 0.5f));
        bool changed = ComboField(label, v, items, count, fp, M.combo_w);
        RowLabel(p, M.row_h, label, 0.0f);
        ImGui::SetCursorScreenPos(p);
        ImGui::Dummy(ImVec2(w, M.row_h));
        return changed;
    }

    const char* KeyName(ImGuiKey key)
    {
        switch (key)
        {
        case ImGuiKey_None:        return "None";
        case ImGuiKey_MouseLeft:   return "Mouse 1";
        case ImGuiKey_MouseRight:  return "Mouse 2";
        case ImGuiKey_MouseMiddle: return "Mouse 3";
        case ImGuiKey_MouseX1:     return "Mouse 4";
        case ImGuiKey_MouseX2:     return "Mouse 5";
        default:                   return ImGui::GetKeyName(key);
        }
    }

    bool KeybindRow(const char* label, Keybind* kb)
    {
        float w;
        ImVec2 p = RowBegin(&w);
        bool changed = false;
        if (ImGui::InvisibleButton(label, ImVec2(w, M.row_h)))
            kb->listening = !kb->listening;
        STUDIO_WIDGET("keybind");
        ImGuiID id = ImGui::GetItemID();
        if (kb->listening && !ImGui::IsItemActive())
        {
            for (int k = ImGuiKey_NamedKey_BEGIN; k < ImGuiKey_NamedKey_END; k++)
            {
                ImGuiKey key = (ImGuiKey)k;
                if ((key >= ImGuiKey_ReservedForModCtrl && key <= ImGuiKey_ReservedForModSuper) ||
                    key == ImGuiKey_MouseWheelX || key == ImGuiKey_MouseWheelY)
                    continue;
                if (!ImGui::IsKeyPressed(key, false))
                    continue;
                if (key != ImGuiKey_Escape)
                {
                    kb->key = key;
                    changed = true;
                }
                kb->listening = false;
                break;
            }
        }
        float h = Anim(id, ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
        float l = Anim(id + 1, kb->listening ? 1.0f : 0.0f, 22);
        STUDIO_STATE("listening", kb->listening ? 1.0f : 0.0f);

        RowLabel(p, M.row_h, label, h);
        const char* txt = kb->listening ? "Press a key..." : KeyName(kb->key);
        ImVec2 ts = TextSize(F.medium, M.fs_small, txt);
        float fw = ImMax(ts.x + 20 * M.scale, 72 * M.scale);
        ImVec2 mn(p.x + w - fw, IM_ROUND(p.y + (M.row_h - M.control_h) * 0.5f)), mx(p.x + w, mn.y + M.control_h);
        ImDrawList* dl = DL();
        dl->AddRectFilled(mn, mx, Col(Mix(C.bg_control, C.bg_control_hi, h)), M.radius_md);
        dl->AddRect(mn, mx, Col(Mix(C.border, Alpha(C.accent, 0.6f), l)), M.radius_md, 0, 1.0f);
        Text(F.medium, M.fs_small, ImVec2(mn.x + (fw - ts.x) * 0.5f, mn.y + (M.control_h - M.fs_small) * 0.5f - 1),
             kb->listening ? C.accent : Mix(C.text_label, C.text, h), txt);
        return changed;
    }

    bool AccentRow(const char* label, ImVec4* colour, const ImVec4* presets, int count)
    {
        float w;
        ImVec2 p = RowBegin(&w);
        bool changed = false;
        float gap = 10 * M.scale, cy = p.y + M.row_h * 0.5f;
        for (int i = 0; i < count; i++)
        {
            ImVec2 sp(p.x + w - M.swatch - (count - 1 - i) * (M.swatch + gap), IM_ROUND(cy - M.swatch * 0.5f));
            ImGui::SetCursorScreenPos(sp);
            ImGui::PushID(i);
            if (ImGui::InvisibleButton("##accent", ImVec2(M.swatch, M.swatch)))
            {
                *colour = presets[i];
                changed = true;
            }
            float h = Anim(ImGui::GetItemID(), ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
            SwatchShape(DL(), sp, M.swatch, presets[i], h, SameColour(*colour, presets[i]));
            ImGui::PopID();
        }
        RowLabel(p, M.row_h, label, 0.0f);
        ImGui::SetCursorScreenPos(p);
        ImGui::Dummy(ImVec2(w, M.row_h));
        return changed;
    }

    void Helper(const char* text)
    {
        float w;
        ImVec2 p = ImGui::GetCursorScreenPos();
        w = g_row_w > 0 ? g_row_w : ImGui::GetContentRegionAvail().x;
        Text(F.regular, M.fs_small, ImVec2(p.x, p.y + M.gap_sm), C.text_dim, text);
        ImGui::Dummy(ImVec2(w, M.gap_sm + M.fs_small + M.gap_md));
    }

    // ---------------------------------------------------------------- free-standing controls

    bool Button(const char* label, ImVec2 size, bool primary)
    {
        ImVec2 p = ImGui::GetCursorScreenPos();
        bool pressed = ImGui::InvisibleButton(label, size);
        STUDIO_WIDGET("button");
        ImGuiID id = ImGui::GetItemID();
        float h = Anim(id, ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
        float a = Anim(id + 1, ImGui::IsItemActive() ? 1.0f : 0.0f, 30);
        ImDrawList* dl = DL();
        ImVec2 mx(p.x + size.x, p.y + size.y);
        if (primary)
        {
            ImVec4 fill = Mix(Mix(C.accent, C.accent_hover, h), Alpha(C.accent, 0.85f), a);
            dl->AddRectFilled(p, mx, Col(fill), M.radius_md);
        }
        else
        {
            dl->AddRectFilled(p, mx, Col(Mix(C.bg_control, C.bg_control_hi, h)), M.radius_md);
            dl->AddRect(p, mx, Col(Mix(C.border, C.border_strong, h)), M.radius_md, 0, 1.0f);
        }
        ImVec2 ts = TextSize(F.medium, M.fs_body, label);
        ImVec4 tc = primary ? Hex(0x16110A) : Mix(C.text_label, C.text, h);
        Text(F.medium, M.fs_body, ImVec2(p.x + (size.x - ts.x) * 0.5f, p.y + (size.y - M.fs_body) * 0.5f - 1), tc, label);
        return pressed;
    }

    bool Segmented(const char* id, int* v, const char* const items[], int count, float width)
    {
        ImVec2 p = ImGui::GetCursorScreenPos();
        const float h = M.control_h, inset = 3 * M.scale, seg = width / count;
        ImDrawList* dl = DL();
        dl->AddRectFilled(p, ImVec2(p.x + width, p.y + h), Col(C.bg_root), M.radius_md);
        dl->AddRect(p, ImVec2(p.x + width, p.y + h), Col(C.border), M.radius_md, 0, 1.0f);
        ImGui::PushID(id);
        float sel = Anim(ImGui::GetID("##sel"), (float)*v, 18);
        ImVec2 sp(p.x + sel * seg + inset, p.y + inset);
        dl->AddRectFilled(sp, ImVec2(sp.x + seg - inset * 2, p.y + h - inset), Col(C.bg_control_hi), M.radius_sm);
        bool changed = false;
        for (int i = 0; i < count; i++)
        {
            ImGui::SetCursorScreenPos(ImVec2(p.x + i * seg, p.y));
            if (ImGui::InvisibleButton(items[i], ImVec2(seg, h)) && *v != i)
            {
                *v = i;
                changed = true;
            }
            STUDIO_WIDGET("segment");
            float hv = Anim(ImGui::GetItemID(), ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
            float on = ImSaturate(1.0f - fabsf(sel - i));
            ImVec2 ts = TextSize(F.medium, M.fs_small, items[i]);
            Text(F.medium, M.fs_small, ImVec2(p.x + i * seg + (seg - ts.x) * 0.5f, p.y + (h - M.fs_small) * 0.5f - 1),
                 Mix(Mix(C.text_muted, C.text_label, hv), C.text, on), items[i]);
        }
        ImGui::PopID();
        ImGui::SetCursorScreenPos(p);
        ImGui::Dummy(ImVec2(width, h));
        return changed;
    }

    bool ListItem(const char* label, const char* meta, bool selected, bool marked, float width)
    {
        ImVec2 p = ImGui::GetCursorScreenPos();
        bool pressed = ImGui::InvisibleButton(label, ImVec2(width, M.list_h));
        STUDIO_WIDGET("list_item");
        ImGuiID id = ImGui::GetItemID();
        float h = Anim(id, ImGui::IsItemHovered() ? 1.0f : 0.0f, 28);
        float a = Anim(id + 1, selected ? 1.0f : 0.0f, 20);
        ImDrawList* dl = DL();
        ImVec2 mx(p.x + width, p.y + M.list_h);
        dl->AddRectFilled(p, mx, Col(Alpha(C.text, 0.035f * h * (1.0f - a))), M.radius_md);
        dl->AddRectFilled(p, mx, Col(Alpha(C.accent, 0.10f * a)), M.radius_md);
        float cy = p.y + M.list_h * 0.5f;
        float lx = p.x + 10 * M.scale;
        if (marked)
        {
            dl->AddCircleFilled(ImVec2(lx + 2 * M.scale, cy), 2.5f * M.scale, Col(C.accent), 12);
        }
        lx += 12 * M.scale;
        Text(F.medium, M.fs_body, ImVec2(lx, cy - M.fs_body * 0.5f - 1), Mix(Mix(C.text_label, C.text, h), C.text, a), label);
        if (meta)
        {
            ImVec2 ms = TextSize(F.regular, M.fs_small, meta);
            Text(F.regular, M.fs_small, ImVec2(mx.x - 10 * M.scale - ms.x, cy - M.fs_small * 0.5f - 1),
                 Mix(C.text_dim, C.text_muted, ImMax(h, a)), meta);
        }
        return pressed;
    }
}
