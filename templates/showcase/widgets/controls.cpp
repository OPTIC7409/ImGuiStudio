// controls.cpp - setting rows: label + description on the left, a custom control on the right.
#include "widgets.hpp"
#include "internal.hpp"

#include "imgui_internal.h"
#include "studio.h"

#include <cmath>
#include <cstdio>

using namespace ui::detail;

namespace ui
{
    // ------------------------------------------------------------------------
    // Toggle: the whole row is clickable; the switch knob springs across.
    // ------------------------------------------------------------------------
    bool Toggle(const char* label, bool* v, const char* description)
    {
        if (!PassFilter(label, description))
            return false;
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const ImRect bb = RowRect(description != nullptr);
        ImGui::ItemSize(bb);
        if (!ImGui::ItemAdd(bb, id))
            return false;

        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(bb, id, &hovered, &held);
        if (pressed)
        {
            *v = !*v;
            ImGui::MarkItemEdited(id);
        }
        STUDIO_WIDGET("toggle");
        STUDIO_LABEL(label);
        STUDIO_BIND(v);

        float t = anim::Get(id, 0, *v ? 1.0f : 0.0f);
        t = anim::Step(t, *v ? 1.0f : 0.0f, Motion(0.24f));
        anim::Set(id, 0, t);
        const float hover = Animate(id, 1, hovered ? 1.0f : 0.0f, 0.12f);
        const float press = Animate(id, 2, held ? 1.0f : 0.0f, 0.08f);
        STUDIO_STATE("anim", t);

        ImDrawList* dl = window->DrawList;
        const theme::Palette& c = theme::Colors();
        RowBackground(dl, bb, hover);
        RowLabel(dl, bb, label, description);

        const ImVec2 sz(42.0f, 24.0f);
        const ImVec2 smin(bb.Max.x - kRowPadX - sz.x, bb.GetCenter().y - sz.y * 0.5f);
        const ImVec2 smax(smin.x + sz.x, smin.y + sz.y);
        const float e = anim::EaseOutBack(t, 1.2f);
        const ImVec4 off = anim::LerpColor(c.control, c.controlHover, hover);
        dl->AddRectFilled(smin, smax, theme::Col(anim::LerpColor(off, c.accent, anim::EaseInOutCubic(t))), sz.y * 0.5f);
        if (t > 0.0f)
            dl->AddRect(smin, smax, theme::Col(ImVec4(1, 1, 1, 0.10f * t)), sz.y * 0.5f, 0, 1.0f);

        const float r = 9.0f;
        const float grow = 5.0f * press;
        const float x0 = smin.x + sz.y * 0.5f;
        const float x1 = smax.x - sz.y * 0.5f;
        const float kx = x0 + (x1 - x0) * e;
        const float cy = (smin.y + smax.y) * 0.5f;
        const ImVec2 kmin(kx - r - grow * (1.0f - t), cy - r);
        const ImVec2 kmax(kx + r + grow * t, cy + r);
        dl->AddRectFilled(ImVec2(kmin.x, kmin.y + 1.5f), ImVec2(kmax.x, kmax.y + 1.5f), IM_COL32(0, 0, 0, 70), r);
        dl->AddRectFilled(kmin, kmax, IM_COL32(255, 255, 255, 255), r);
        return pressed;
    }

    // ------------------------------------------------------------------------
    // Slider: label + value on the first line, a full-width track below.
    // The interactive item is exactly the track, so t = (mouse.x - left) / width.
    // ------------------------------------------------------------------------
    bool Slider(const char* label, float* v, float v_min, float v_max, const char* format, const char* description)
    {
        if (!PassFilter(label, description))
            return false;
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const float h = description ? 76.0f : 60.0f;
        const ImVec2 pos = window->DC.CursorPos;
        const ImRect bb(pos, ImVec2(pos.x + ImGui::GetContentRegionAvail().x, pos.y + h));
        ImGui::ItemSize(bb);

        const float x0 = bb.Min.x + kRowPadX + 2.0f;
        const float x1 = bb.Max.x - kRowPadX - 2.0f;
        const float ty = bb.Max.y - 17.0f;
        const ImRect track(ImVec2(x0, ty - 10.0f), ImVec2(x1, ty + 10.0f));
        if (!ImGui::ItemAdd(track, id))
            return false;

        bool hovered, held;
        ImGui::ButtonBehavior(track, id, &hovered, &held, ImGuiButtonFlags_PressedOnClick);
        bool changed = false;
        if (held)
        {
            const float mt = ImClamp((ImGui::GetIO().MousePos.x - x0) / (x1 - x0), 0.0f, 1.0f);
            const float nv = v_min + (v_max - v_min) * mt;
            if (nv != *v)
            {
                *v = nv;
                changed = true;
                ImGui::MarkItemEdited(id);
            }
        }
        STUDIO_WIDGET("slider");
        STUDIO_LABEL(label);
        STUDIO_BIND(v);

        const float target = ImClamp((*v - v_min) / (v_max - v_min), 0.0f, 1.0f);
        float shown = anim::Get(id, 0, target);
        shown = held ? target : anim::Approach(shown, target, Motion(0.10f));
        anim::Set(id, 0, shown);
        const float focus = Animate(id, 1, (hovered || held) ? 1.0f : 0.0f, 0.12f);
        const float active = Animate(id, 2, held ? 1.0f : 0.0f, 0.10f);
        STUDIO_STATE("fraction", shown);

        ImDrawList* dl = window->DrawList;
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        RowBackground(dl, bb, focus * 0.6f);
        const float ly = bb.Min.y + 11.0f;
        TextAt(dl, f.medium, theme::kLabel, ImVec2(bb.Min.x + kRowPadX, ly), theme::Col(c.text), VisibleText(label).c_str());
        if (description)
            TextAt(dl, f.regular, theme::kSmall, ImVec2(bb.Min.x + kRowPadX, ly + 20.0f), theme::Col(c.textDim), description);

        char buf[64];
        snprintf(buf, sizeof(buf), format, *v);
        const ImVec2 vs = TextSize(f.medium, theme::kLabel, buf);
        const ImVec2 vpos(bb.Max.x - kRowPadX - vs.x, ly);
        const ImVec4 vcol = anim::LerpColor(c.textDim, c.text, focus);
        if (active > 0.01f)
        {
            const ImVec2 pmin(vpos.x - 8.0f, vpos.y - 3.0f);
            const ImVec2 pmax(vpos.x + vs.x + 8.0f, vpos.y + vs.y + 3.0f);
            dl->AddRectFilled(pmin, pmax, theme::Col(c.accentSoft, active * 1.6f), 6.0f);
        }
        TextAt(dl, f.medium, theme::kLabel, vpos, theme::Col(anim::LerpColor(vcol, c.accent, active)), buf);

        const float th = 4.0f;
        const float kx = x0 + (x1 - x0) * shown;
        dl->AddRectFilled(ImVec2(x0, ty - th * 0.5f), ImVec2(x1, ty + th * 0.5f), theme::Col(c.control), th);
        if (kx > x0 + 0.5f)
            dl->AddRectFilled(ImVec2(x0, ty - th * 0.5f), ImVec2(kx, ty + th * 0.5f), theme::Col(c.accent), th);
        const float kr = 7.0f + 2.0f * focus;
        if (focus > 0.01f)
            dl->AddCircleFilled(ImVec2(kx, ty), kr + 6.0f, theme::Col(c.accent, 0.18f * focus), 32);
        dl->AddCircleFilled(ImVec2(kx, ty + 1.5f), kr, IM_COL32(0, 0, 0, 60), 32);
        dl->AddCircleFilled(ImVec2(kx, ty), kr, IM_COL32(255, 255, 255, 255), 32);
        dl->AddCircle(ImVec2(kx, ty), kr - 1.0f, theme::Col(c.accent), 32, 2.0f);
        return changed;
    }

    // ------------------------------------------------------------------------
    // Segmented control with a sliding selection pill.
    // ------------------------------------------------------------------------
    bool Segmented(const char* label, int* current, const char* const items[], int count, const char* description)
    {
        if (!PassFilter(label, description))
            return false;
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const theme::Fonts& f = theme::Font();
        const float pad = 3.0f;
        const float segH = 30.0f;
        float widths[16];
        float total = 0.0f;
        count = ImMin(count, 16);
        for (int i = 0; i < count; i++)
        {
            widths[i] = TextSize(f.medium, theme::kSmall, items[i]).x + 26.0f;
            total += widths[i];
        }

        // Inline when label and control fit on one line, otherwise stack the control under the label.
        const float rowW = ImGui::GetContentRegionAvail().x;
        const float labelW = TextSize(f.medium, theme::kLabel, VisibleText(label).c_str()).x;
        const bool stacked = labelW + 24.0f + total + pad * 2.0f > rowW - kRowPadX * 2.0f;
        ImRect bb = RowRect(description != nullptr);
        ImRect group;
        if (stacked)
        {
            const float labelH = description ? 50.0f : 34.0f;
            bb.Max.y = bb.Min.y + labelH + segH + pad * 2.0f + 10.0f;
            group = ImRect(ImVec2(bb.Min.x + kRowPadX, bb.Min.y + labelH), ImVec2(bb.Max.x - kRowPadX, bb.Min.y + labelH + segH + pad * 2.0f));
            const float extra = (group.GetWidth() - pad * 2.0f - total) / count;
            for (int i = 0; i < count; i++)
                widths[i] += extra;
        }
        else
        {
            const ImVec2 gmin(bb.Max.x - kRowPadX - total - pad * 2.0f, bb.GetCenter().y - segH * 0.5f - pad);
            group = ImRect(gmin, ImVec2(bb.Max.x - kRowPadX, gmin.y + segH + pad * 2.0f));
        }
        ImGui::ItemSize(bb);
        if (!ImGui::ItemAdd(group, id))
            return false;
        STUDIO_WIDGET("segmented");
        STUDIO_LABEL(label);
        STUDIO_BIND(current);

        // Target pill geometry
        float tx = group.Min.x + pad;
        for (int i = 0; i < *current && i < count; i++)
            tx += widths[i];
        const float tw = (*current >= 0 && *current < count) ? widths[*current] : 0.0f;
        float px = anim::Get(id, 0, tx);
        float pw = anim::Get(id, 1, tw);
        px = anim::Approach(px, tx, Motion(0.16f));
        pw = anim::Approach(pw, tw, Motion(0.16f));
        anim::Set(id, 0, px);
        anim::Set(id, 1, pw);
        STUDIO_STATE("pill_x", px - group.Min.x);

        ImDrawList* dl = window->DrawList;
        const theme::Palette& c = theme::Colors();
        const float rowHover = Animate(id, 2, ImGui::IsMouseHoveringRect(bb.Min, bb.Max) ? 1.0f : 0.0f, 0.12f);
        RowBackground(dl, bb, rowHover);
        if (stacked)
            RowLabel(dl, ImRect(bb.Min, ImVec2(bb.Max.x, bb.Min.y + (description ? 58.0f : 36.0f))), label, description);
        else
            RowLabel(dl, bb, label, description);
        dl->AddRectFilled(group.Min, group.Max, theme::Col(c.control), 9.0f);
        if (pw > 0.5f)
        {
            const ImVec2 pmin(px, group.Min.y + pad);
            const ImVec2 pmax(px + pw, group.Max.y - pad);
            dl->AddRectFilled(ImVec2(pmin.x, pmin.y + 1.0f), ImVec2(pmax.x, pmax.y + 1.0f), IM_COL32(0, 0, 0, 60), 7.0f);
            dl->AddRectFilled(pmin, pmax, theme::Col(c.accent), 7.0f);
        }

        bool changed = false;
        ImGui::PushID(label);
        STUDIO_SCOPE(label);
        float x = group.Min.x + pad;
        for (int i = 0; i < count; i++)
        {
            const ImRect seg(ImVec2(x, group.Min.y + pad), ImVec2(x + widths[i], group.Max.y - pad));
            const ImGuiID sid = window->GetID(items[i]);
            x += widths[i];
            if (!ImGui::ItemAdd(seg, sid))
                continue;
            STUDIO_WIDGET("segment");
            STUDIO_LABEL(items[i]);
            bool sh, sheld;
            if (ImGui::ButtonBehavior(seg, sid, &sh, &sheld) && *current != i)
            {
                *current = i;
                changed = true;
                ImGui::MarkItemEdited(id);
            }
            const float hv = Animate(sid, 0, sh ? 1.0f : 0.0f, 0.1f);
            // Text colour follows the pill: white where the pill covers the segment.
            const float cover = ImClamp((ImMin(px + pw, seg.Max.x) - ImMax(px, seg.Min.x)) / seg.GetWidth(), 0.0f, 1.0f);
            const ImVec4 base = anim::LerpColor(c.textDim, c.text, hv);
            const ImVec4 col = anim::LerpColor(base, ImVec4(1, 1, 1, 1), cover);
            const ImVec2 ts = TextSize(f.medium, theme::kSmall, items[i]);
            TextAt(dl, f.medium, theme::kSmall, ImVec2(seg.GetCenter().x - ts.x * 0.5f, seg.GetCenter().y - ts.y * 0.5f), theme::Col(col), items[i]);
        }
        ImGui::PopID();
        return changed;
    }

    // ------------------------------------------------------------------------
    // Combo: styled dropdown button + animated popup list.
    // ------------------------------------------------------------------------
    bool Combo(const char* label, int* current, const char* const items[], int count, const char* description)
    {
        if (!PassFilter(label, description))
            return false;
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const ImRect bb = RowRect(description != nullptr);
        ImGui::ItemSize(bb);
        const float bw = 196.0f;
        const float bh = 34.0f;
        const ImRect btn(ImVec2(bb.Max.x - kRowPadX - bw, bb.GetCenter().y - bh * 0.5f), ImVec2(bb.Max.x - kRowPadX, bb.GetCenter().y + bh * 0.5f));
        if (!ImGui::ItemAdd(btn, id))
            return false;

        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(btn, id, &hovered, &held);
        ImGui::PushID(label);
        const ImGuiID popupId = ImGui::GetID("##popup");
        bool open = ImGui::IsPopupOpen(popupId, 0);
        if (pressed && !open)
        {
            ImGui::OpenPopup("##popup");
            open = true;
        }
        STUDIO_WIDGET("combo");
        STUDIO_LABEL(label);
        STUDIO_BIND(current);
        STUDIO_STATE("open", open);

        const float hv = Animate(id, 0, hovered ? 1.0f : 0.0f, 0.12f);
        const float op = Animate(id, 1, open ? 1.0f : 0.0f, 0.16f);
        float appear = anim::Get(id, 2, 0.0f);
        appear = open ? anim::Step(appear, 1.0f, Motion(0.16f)) : 0.0f;
        anim::Set(id, 2, appear);

        ImDrawList* dl = window->DrawList;
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        RowBackground(dl, bb, ImGui::IsMouseHoveringRect(bb.Min, bb.Max) ? 0.6f : 0.0f);
        RowLabel(dl, bb, label, description);
        dl->AddRectFilled(btn.Min, btn.Max, theme::Col(anim::LerpColor(c.control, c.controlHover, ImMax(hv, op))), 9.0f);
        dl->AddRect(btn.Min, btn.Max, theme::Col(c.accent, op), 9.0f, 0, 1.5f);
        const char* text = (*current >= 0 && *current < count) ? items[*current] : "";
        const ImVec2 ts = TextSize(f.medium, theme::kSmall + 0.5f, text);
        TextAt(dl, f.medium, theme::kSmall + 0.5f, ImVec2(btn.Min.x + 12.0f, btn.GetCenter().y - ts.y * 0.5f), theme::Col(c.text), text);
        DrawIcon(dl, Icon::Chevron, ImVec2(btn.Max.x - 16.0f, btn.GetCenter().y), 11.0f, theme::Col(anim::LerpColor(c.textDim, c.text, ImMax(hv, op))), 1.6f, 3.14159265f * anim::EaseInOutCubic(op));

        bool changed = false;
        if (open)
        {
            const float e = anim::EaseOutCubic(appear);
            ImGui::SetNextWindowPos(ImVec2(btn.Min.x, btn.Max.y + 6.0f - 6.0f * (1.0f - e)));
            ImGui::SetNextWindowSize(ImVec2(bw, 0.0f));
            ImGui::PushStyleVar(ImGuiStyleVar_Alpha, e);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(5, 5));
            ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(0, 2));
            ImGui::PushStyleVar(ImGuiStyleVar_PopupRounding, 10.0f);
            if (ImGui::BeginPopup("##popup", ImGuiWindowFlags_NoMove))
            {
                STUDIO_SCOPE(label);
                ImDrawList* pdl = ImGui::GetWindowDrawList();
                for (int i = 0; i < count; i++)
                {
                    const ImVec2 p = ImGui::GetCursorScreenPos();
                    const ImVec2 sz(ImGui::GetContentRegionAvail().x, 30.0f);
                    const bool clicked = ImGui::InvisibleButton(items[i], sz);
                    STUDIO_WIDGET("option");
                    const bool ih = ImGui::IsItemHovered();
                    const ImGuiID oid = ImGui::GetItemID();
                    const float oh = Animate(oid, 0, ih ? 1.0f : 0.0f, 0.08f);
                    const bool sel = i == *current;
                    if (sel || oh > 0.01f)
                        pdl->AddRectFilled(p, ImVec2(p.x + sz.x, p.y + sz.y), theme::Col(sel ? c.accentSoft : ImVec4(1, 1, 1, 0.05f), sel ? 1.0f : oh), 7.0f);
                    const ImVec2 its = TextSize(f.regular, theme::kSmall + 0.5f, items[i]);
                    TextAt(pdl, sel ? f.medium : f.regular, theme::kSmall + 0.5f, ImVec2(p.x + 10.0f, p.y + (sz.y - its.y) * 0.5f), theme::Col(sel ? c.text : anim::LerpColor(c.textDim, c.text, oh)), items[i]);
                    if (sel)
                        DrawIcon(pdl, Icon::Check, ImVec2(p.x + sz.x - 16.0f, p.y + sz.y * 0.5f), 12.0f, theme::Col(c.accent), 2.0f);
                    if (clicked)
                    {
                        if (*current != i)
                        {
                            *current = i;
                            changed = true;
                            ImGui::MarkItemEdited(id);
                        }
                        ImGui::CloseCurrentPopup();
                    }
                }
                ImGui::EndPopup();
            }
            ImGui::PopStyleVar(4);
        }
        ImGui::PopID();
        return changed;
    }

    // ------------------------------------------------------------------------
    // Keybind: click, then press a key (Escape cancels).
    // ------------------------------------------------------------------------
    static ImGuiID g_Listening = 0;

    bool Keybind(const char* label, ImGuiKey* key, const char* description)
    {
        if (!PassFilter(label, description))
            return false;
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const ImRect bb = RowRect(description != nullptr);
        ImGui::ItemSize(bb);

        const theme::Fonts& f = theme::Font();
        const bool listening = g_Listening == id;
        const char* text = listening ? "Press a key..." : ImGui::GetKeyName(*key);
        const ImVec2 ts = TextSize(f.medium, theme::kSmall, text);
        const float cw = ImMax(64.0f, ts.x + 28.0f);
        const float ch = 30.0f;
        const ImRect chip(ImVec2(bb.Max.x - kRowPadX - cw, bb.GetCenter().y - ch * 0.5f), ImVec2(bb.Max.x - kRowPadX, bb.GetCenter().y + ch * 0.5f));
        if (!ImGui::ItemAdd(chip, id))
            return false;
        bool hovered, held;
        const bool pressed = ImGui::ButtonBehavior(chip, id, &hovered, &held);
        STUDIO_WIDGET("keybind");
        STUDIO_LABEL(label);
        STUDIO_STATE("key", ImGui::GetKeyName(*key));
        STUDIO_STATE("listening", listening);
        if (pressed)
            g_Listening = listening ? 0 : id;

        bool changed = false;
        if (listening && !pressed)
        {
            if (ImGui::IsMouseClicked(ImGuiMouseButton_Left) && !hovered)
                g_Listening = 0;
            for (int k = ImGuiKey_NamedKey_BEGIN; k < ImGuiKey_NamedKey_END; k++)
            {
                if (k >= ImGuiKey_MouseLeft && k <= ImGuiKey_MouseWheelY)
                    continue;
                if (k >= ImGuiKey_ReservedForModCtrl && k <= ImGuiKey_ReservedForModSuper)
                    continue;
                if (ImGui::IsKeyPressed((ImGuiKey)k, false))
                {
                    if (k != ImGuiKey_Escape)
                    {
                        *key = (ImGuiKey)k;
                        changed = true;
                        ImGui::MarkItemEdited(id);
                    }
                    g_Listening = 0;
                    break;
                }
            }
        }

        ImDrawList* dl = window->DrawList;
        const theme::Palette& c = theme::Colors();
        const float hv = Animate(id, 0, hovered ? 1.0f : 0.0f, 0.12f);
        const float ls = Animate(id, 1, listening ? 1.0f : 0.0f, 0.14f);
        RowBackground(dl, bb, ImGui::IsMouseHoveringRect(bb.Min, bb.Max) ? 0.6f : 0.0f);
        RowLabel(dl, bb, label, description);
        const float pulse = 0.55f + 0.45f * sinf((float)ImGui::GetTime() * 6.0f);
        dl->AddRectFilled(chip.Min, chip.Max, theme::Col(anim::LerpColor(anim::LerpColor(c.control, c.controlHover, hv), c.accentSoft, ls)), 8.0f);
        dl->AddRect(chip.Min, chip.Max, theme::Col(c.accent, ls * pulse), 8.0f, 0, 1.5f);
        dl->AddLine(ImVec2(chip.Min.x + 6.0f, chip.Max.y - 1.0f), ImVec2(chip.Max.x - 6.0f, chip.Max.y - 1.0f), IM_COL32(0, 0, 0, 90), 2.0f);
        TextAt(dl, f.medium, theme::kSmall, ImVec2(chip.GetCenter().x - ts.x * 0.5f, chip.GetCenter().y - ts.y * 0.5f), theme::Col(anim::LerpColor(c.text, c.accent, ls)), text);
        return changed;
    }

    // ------------------------------------------------------------------------
    // Colour swatches (single choice).
    // ------------------------------------------------------------------------
    bool ColorSwatches(const char* label, int* current, const ImVec4* colors, const char* const names[], int count, const char* description)
    {
        if (!PassFilter(label, description))
            return false;
        ImGuiWindow* window = ImGui::GetCurrentWindow();
        if (window->SkipItems)
            return false;
        const ImGuiID id = window->GetID(label);
        const ImRect bb = RowRect(description != nullptr);
        ImGui::ItemSize(bb);
        const float d = 24.0f;
        const float gap = 10.0f;
        const float total = count * d + (count - 1) * gap;
        const ImRect group(ImVec2(bb.Max.x - kRowPadX - total - 4.0f, bb.GetCenter().y - d * 0.5f - 4.0f), ImVec2(bb.Max.x - kRowPadX + 4.0f, bb.GetCenter().y + d * 0.5f + 4.0f));
        if (!ImGui::ItemAdd(group, id))
            return false;
        STUDIO_WIDGET("swatches");
        STUDIO_LABEL(label);
        STUDIO_BIND(current);

        ImDrawList* dl = window->DrawList;
        const theme::Palette& c = theme::Colors();
        RowBackground(dl, bb, ImGui::IsMouseHoveringRect(bb.Min, bb.Max) ? 0.6f : 0.0f);
        RowLabel(dl, bb, label, description);

        bool changed = false;
        ImGui::PushID(label);
        STUDIO_SCOPE(label);
        for (int i = 0; i < count; i++)
        {
            const ImVec2 center(group.Min.x + 4.0f + d * 0.5f + i * (d + gap), bb.GetCenter().y);
            const ImRect sb(ImVec2(center.x - d * 0.5f, center.y - d * 0.5f), ImVec2(center.x + d * 0.5f, center.y + d * 0.5f));
            const ImGuiID sid = window->GetID(names[i]);
            if (!ImGui::ItemAdd(sb, sid))
                continue;
            STUDIO_WIDGET("swatch");
            STUDIO_LABEL(names[i]);
            bool sh, sheld;
            if (ImGui::ButtonBehavior(sb, sid, &sh, &sheld) && *current != i)
            {
                *current = i;
                changed = true;
                ImGui::MarkItemEdited(id);
            }
            const float sel = Animate(sid, 0, *current == i ? 1.0f : 0.0f, 0.18f);
            const float hv = Animate(sid, 1, sh ? 1.0f : 0.0f, 0.1f);
            const float r = d * 0.5f - 1.0f * (1.0f - hv) + 1.0f * hv - 3.0f * sel;
            if (sel > 0.01f)
                dl->AddCircle(center, d * 0.5f + 1.5f, theme::Col(colors[i], sel), 32, 2.0f);
            dl->AddCircleFilled(center, r, theme::Col(colors[i]), 32);
            if (sel > 0.01f)
                DrawIcon(dl, Icon::Check, center, 9.0f * anim::EaseOutBack(sel), theme::Col(ImVec4(1, 1, 1, sel)), 2.0f);
        }
        ImGui::PopID();
        (void)c;
        return changed;
    }
}
