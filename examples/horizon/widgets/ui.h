// Custom control layer. Everything visible is drawn with ImDrawList; ImGui provides ids, input and clipping.
#pragma once
#include "imgui.h"

namespace ui
{
    enum class Icon { Crosshair, Eye, Shield, Sliders, Folder, Check, Logo };

    struct Keybind
    {
        ImGuiKey key = ImGuiKey_None;
        bool     listening = false;
    };

    // Exponential ease-out towards target; speed 20 settles in ~150 ms. Never overshoots.
    float Anim(ImGuiID id, float target, float speed = 20.0f);
    void  SetReducedMotion(bool reduced);

    void  DrawIcon(ImDrawList* dl, Icon icon, ImVec2 center, float size, ImU32 col);
    void  DrawChevron(ImDrawList* dl, ImVec2 center, float size, ImU32 col, float open_t);
    void  Text(ImFont* font, float size, ImVec2 pos, const ImVec4& col, const char* text);
    ImVec2 TextSize(ImFont* font, float size, const char* text);

    // Navigation
    void  NavGroup(const char* label, float width);
    bool  NavItem(Icon icon, const char* label, bool selected, float width);

    // Cards: auto-height (or min_h) surfaces; rows inside take the card's inner width.
    void  BeginCard(const char* title, float width, float min_h = 0.0f, const char* hint = nullptr);
    void  EndCard();
    float CardInnerWidth();
    float LastCardNaturalBottom(); // content bottom of the last card, ignoring min_h

    // Setting rows
    bool  Toggle(const char* label, bool* v, ImVec4* colour = nullptr);
    bool  Slider(const char* label, float* v, float v_min, float v_max, const char* fmt);
    bool  Combo(const char* label, int* v, const char* const items[], int count);
    bool  KeybindRow(const char* label, Keybind* kb);
    bool  AccentRow(const char* label, ImVec4* colour, const ImVec4* presets, int count);
    void  Helper(const char* text);

    // Free-standing controls
    bool  ComboField(const char* id, int* v, const char* const items[], int count, ImVec2 pos, float width);
    bool  Button(const char* label, ImVec2 size, bool primary);
    bool  Segmented(const char* id, int* v, const char* const items[], int count, float width);
    bool  ListItem(const char* label, const char* meta, bool selected, bool marked, float width);
    const char* KeyName(ImGuiKey key);
}
