// anim.hpp - small, frame-rate independent animation helpers.
//
// All timing is driven by ImGui::GetIO().DeltaTime, so animations behave the
// same at any frame rate and are captured deterministically by ImGui Studio.
#pragma once

#include "imgui.h"
#include <cmath>

namespace anim
{
    inline float Clamp01(float t) { return t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t); }
    inline float Lerp(float a, float b, float t) { return a + (b - a) * t; }
    inline ImVec2 Lerp(const ImVec2& a, const ImVec2& b, float t) { return ImVec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }

    inline float EaseOutCubic(float t) { t = Clamp01(t); const float u = 1.0f - t; return 1.0f - u * u * u; }
    inline float EaseInOutCubic(float t) { t = Clamp01(t); return t < 0.5f ? 4.0f * t * t * t : 1.0f - powf(-2.0f * t + 2.0f, 3.0f) * 0.5f; }
    inline float EaseOutBack(float t, float overshoot = 1.70158f)
    {
        t = Clamp01(t);
        const float u = t - 1.0f;
        return 1.0f + (overshoot + 1.0f) * u * u * u + overshoot * u * u;
    }

    // Exponential approach: covers ~99% of the distance to `target` in `duration` seconds.
    inline float Approach(float current, float target, float duration)
    {
        if (duration <= 0.0f)
            return target;
        const float k = 1.0f - expf(-4.6f * ImGui::GetIO().DeltaTime / duration);
        const float v = current + (target - current) * k;
        return fabsf(v - target) < 0.0005f ? target : v;
    }

    // Linear progress towards `target` (0 or 1) taking `duration` seconds for a full 0 -> 1 run.
    inline float Step(float current, float target, float duration)
    {
        const float d = duration > 0.0f ? ImGui::GetIO().DeltaTime / duration : 1.0f;
        return current < target ? (current + d > target ? target : current + d) : (current - d < target ? target : current - d);
    }

    // Per-widget persistent animation values, stored in the window's ImGuiStorage.
    inline ImGuiID Key(ImGuiID id, int slot) { return id * 2654435761u + (ImGuiID)slot + 1u; }
    inline float Get(ImGuiID id, int slot, float init) { return ImGui::GetStateStorage()->GetFloat(Key(id, slot), init); }
    inline void Set(ImGuiID id, int slot, float v) { ImGui::GetStateStorage()->SetFloat(Key(id, slot), v); }

    inline ImVec4 LerpColor(const ImVec4& a, const ImVec4& b, float t)
    {
        return ImVec4(Lerp(a.x, b.x, t), Lerp(a.y, b.y, t), Lerp(a.z, b.z, t), Lerp(a.w, b.w, t));
    }
}
