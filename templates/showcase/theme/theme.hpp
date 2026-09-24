// theme.hpp - palette, typography and Dear ImGui style for the showcase UI.
#pragma once

#include "imgui.h"

namespace theme
{
    struct Palette
    {
        ImVec4 backdrop;     // behind the window
        ImVec4 window;
        ImVec4 sidebar;
        ImVec4 card;
        ImVec4 cardBorder;
        ImVec4 control;      // inputs, tracks
        ImVec4 controlHover;
        ImVec4 divider;
        ImVec4 text;
        ImVec4 textDim;
        ImVec4 textFaint;
        ImVec4 accent;
        ImVec4 accentSoft;   // accent at low alpha
        ImVec4 success;
        ImVec4 danger;
    };

    struct Fonts
    {
        ImFont* regular = nullptr;
        ImFont* medium = nullptr;
        ImFont* semibold = nullptr;
    };

    // Type scale (pixels)
    constexpr float kBody = 14.0f;
    constexpr float kSmall = 12.5f;
    constexpr float kLabel = 14.0f;
    constexpr float kSection = 11.5f;
    constexpr float kTitle = 22.0f;

    // Spacing / shape
    constexpr float kRadius = 10.0f;
    constexpr float kPad = 18.0f;

    extern const ImVec4 kAccents[6];
    extern const char* const kAccentNames[6];

    void Init();                    // load fonts + apply style (call from AppInit)
    void SetAccent(int index);
    void SetAccentColor(const ImVec4& c);
    const Palette& Colors();
    const Fonts& Font();

    ImU32 Col(const ImVec4& c, float alpha_mul = 1.0f);
}
