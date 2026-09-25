// Line icons drawn with the draw list (Lucide-like: 16 px grid, 1.5 px stroke, round feel).
#pragma once
#include "imgui.h"

namespace ui
{
    enum class Icon
    {
        General,     // sliders-horizontal
        Audio,       // audio-lines
        Midi,        // piano keys
        Appearance,  // contrast circle
        Shortcuts,   // keyboard
        Chevron,     // chevron-down
        Check,
        Folder,
        Logo,        // brand waveform (drawn on accent tile)
    };

    // Draws icon centred on `c`; `size` is the icon box (16 px at 1x).
    void DrawIcon(ImDrawList* dl, Icon icon, ImVec2 c, float size, ImU32 col, float stroke);

    // Chevron with open progress t in [0,1] (0 = pointing down, 1 = pointing up).
    void DrawChevron(ImDrawList* dl, ImVec2 c, float size, ImU32 col, float stroke, float t);
}
