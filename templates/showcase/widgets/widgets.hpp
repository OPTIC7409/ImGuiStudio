// widgets.hpp - custom Dear ImGui widgets for the showcase UI.
//
// Every widget is plain Dear ImGui: layout through ItemSize/ItemAdd (or
// InvisibleButton), rendering through ImDrawList, animation through
// ImGui::GetIO().DeltaTime. The STUDIO_* annotations only describe the widgets
// to ImGui Studio and compile to nothing in native builds.
#pragma once

#include "imgui.h"

namespace ui
{
    // --- Icons (vector, drawn with ImDrawList) -------------------------------
    enum class Icon
    {
        None, Logo, General, Monitor, Speaker, Keyboard, Palette, Search, Check, Chevron, Close, Info, Sparkle, Bolt,
    };
    void DrawIcon(ImDrawList* dl, Icon icon, const ImVec2& center, float size, ImU32 col, float thickness = 1.6f, float rotation = 0.0f);

    // --- Layout ----------------------------------------------------------------
    bool  BeginCard(const char* id, const char* title, const char* subtitle = nullptr, float width = 0.0f);
    void  EndCard();
    void  SectionLabel(const char* text);
    void  Divider();

    // Global search filter: rows whose label does not match are skipped.
    void  SetFilter(const char* text);
    bool  PassFilter(const char* label, const char* description = nullptr);
    int   FilteredOutCount();

    // --- Rows (label/description on the left, control on the right) -----------
    bool  Toggle(const char* label, bool* v, const char* description = nullptr);
    bool  Slider(const char* label, float* v, float v_min, float v_max, const char* format = "%.0f", const char* description = nullptr);
    bool  Segmented(const char* label, int* current, const char* const items[], int count, const char* description = nullptr);
    bool  Combo(const char* label, int* current, const char* const items[], int count, const char* description = nullptr);
    bool  Keybind(const char* label, ImGuiKey* key, const char* description = nullptr);
    bool  ColorSwatches(const char* label, int* current, const ImVec4* colors, const char* const names[], int count, const char* description = nullptr);

    // --- Standalone controls -----------------------------------------------------
    bool  NavItem(const char* label, Icon icon, bool selected, float label_alpha = 1.0f);
    bool  Button(const char* label, bool primary, const ImVec2& size = ImVec2(0, 0), bool enabled = true);
    bool  SearchField(const char* id, char* buf, int buf_size, float width);
    void  Sparkline(const char* id, const float* values, int count, float v_min, float v_max, const ImVec2& size);

    // --- Notifications -------------------------------------------------------------
    void  PushToast(const char* title, const char* message);
    void  RenderToasts(const ImVec2& anchor_bottom_right);

    // Global animation speed multiplier (1 = normal, 0 = instant, for "reduce motion").
    float& MotionScale();

    // --- Drawing helpers -----------------------------------------------------------
    void  SoftShadow(ImDrawList* dl, const ImVec2& min, const ImVec2& max, float rounding, float spread, ImU32 col);
    void  TextAt(ImDrawList* dl, ImFont* font, float size, const ImVec2& pos, ImU32 col, const char* text);
    ImVec2 TextSize(ImFont* font, float size, const char* text);
}
