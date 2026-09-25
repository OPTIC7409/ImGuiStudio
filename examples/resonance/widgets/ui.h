// Custom control layer for the Resonance settings window.
// Every visible pixel is drawn here with ImDrawList; ImGui provides layout, ids and input.
#pragma once
#include "imgui.h"
#include "icons.h"

namespace ui
{
    // ---- Motion ---------------------------------------------------------
    // Critically damped ease-out towards `target`; ~98% settled after `duration` seconds.
    float Animate(ImGuiID id, float target, float duration = 0.15f);
    void  AnimateSet(ImGuiID id, float value);
    float EaseOutCubic(float t);

    // ---- Text -----------------------------------------------------------
    // Sizes are unscaled type tokens (theme::Type); scaling is applied inside.
    ImVec2 Measure(ImFont* font, float size, const char* text);
    void   Text(ImDrawList* dl, ImFont* font, float size, ImVec2 pos, ImU32 col, const char* text);
    // Places the text vertically centred in [y0, y1].
    void   TextV(ImDrawList* dl, ImFont* font, float size, float x, float y0, float y1, ImU32 col, const char* text);

    // ---- Structure ------------------------------------------------------
    // Card = child window with auto height. `meta` is optional right-aligned header text.
    void BeginCard(const char* id, const char* title, float width, const char* meta = nullptr);
    void EndCard();
    // Adds vertical space inside a card / page.
    void Spacing(float px_unscaled);

    // ---- Settings rows (fill the card width) ---------------------------
    bool Toggle(const char* label, bool* v, const char* desc = nullptr);
    bool Slider(const char* label, float* v, float min, float max, const char* fmt, float step = 0.0f);
    bool SliderSteps(const char* label, int* index, int count, const char* value_text);
    bool Combo(const char* label, int* current, const char* const items[], int count);
    bool Segmented(const char* label, int* current, const char* const items[], int count);
    bool ColorField(const char* label, ImVec4* colour);
    bool Keybind(const char* label, ImGuiKeyChord* chord);
    bool PathField(const char* label, const char* path);   // returns true when "Browse" clicked
    void InfoRow(const char* label, const char* value, const ImVec4* dot = nullptr);

    // Full-width strip of read-only figures separated by hairlines.
    struct Stat { const char* label; const char* value; const char* unit; const ImVec4* dot; };
    void StatStrip(const char* id, const Stat* stats, int count);

    // ---- Standalone controls -------------------------------------------
    enum class ButtonKind { Primary, Secondary };
    bool Button(const char* label, ButtonKind kind, float height = 0.0f, bool enabled = true);
    // Dropdown field of explicit width; `prefix` is dim text drawn before the value.
    bool ComboBox(const char* id, int* current, const char* const items[], int count, float width, const char* prefix = nullptr);
    bool NavItem(Icon icon, const char* label, bool selected);

    void SectionCaption(ImDrawList* dl, ImVec2 pos, const char* text);
    void KeyChordName(ImGuiKeyChord chord, char* buf, int buf_size);
}
