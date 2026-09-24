// internal.hpp - helpers shared by the widget implementations.
#pragma once

#include "imgui.h"
#include "imgui_internal.h"
#include "anim.hpp"
#include "theme.hpp"
#include "widgets.hpp"

#include <string>

namespace ui
{
    namespace detail
    {
        constexpr float kRowPadX = 14.0f;

        inline float Motion(float seconds) { return seconds * MotionScale(); }

        // Animate a per-widget value towards target (exponential, frame-rate independent).
        inline float Animate(ImGuiID id, int slot, float target, float seconds)
        {
            float v = anim::Get(id, slot, target);
            v = anim::Approach(v, target, Motion(seconds));
            anim::Set(id, slot, v);
            return v;
        }

        inline std::string VisibleText(const char* label)
        {
            const char* end = ImGui::FindRenderedTextEnd(label);
            return std::string(label, end);
        }

        inline ImRect RowRect(bool has_description)
        {
            ImGuiWindow* window = ImGui::GetCurrentWindow();
            const ImVec2 pos = window->DC.CursorPos;
            const float h = has_description ? 56.0f : 42.0f;
            return ImRect(pos, ImVec2(pos.x + ImGui::GetContentRegionAvail().x, pos.y + h));
        }

        inline void RowBackground(ImDrawList* dl, const ImRect& bb, float hover)
        {
            if (hover > 0.01f)
                dl->AddRectFilled(bb.Min, bb.Max, IM_COL32(255, 255, 255, (int)(9.0f * hover)), 8.0f);
        }

        inline void RowLabel(ImDrawList* dl, const ImRect& bb, const char* label, const char* description)
        {
            const theme::Palette& c = theme::Colors();
            const theme::Fonts& f = theme::Font();
            const std::string text = VisibleText(label);
            const float x = bb.Min.x + kRowPadX;
            if (description)
            {
                TextAt(dl, f.medium, theme::kLabel, ImVec2(x, bb.Min.y + 11.0f), theme::Col(c.text), text.c_str());
                TextAt(dl, f.regular, theme::kSmall, ImVec2(x, bb.Min.y + 31.0f), theme::Col(c.textDim), description);
            }
            else
            {
                const ImVec2 ts = TextSize(f.medium, theme::kLabel, text.c_str());
                TextAt(dl, f.medium, theme::kLabel, ImVec2(x, bb.GetCenter().y - ts.y * 0.5f), theme::Col(c.text), text.c_str());
            }
        }
    }
}
