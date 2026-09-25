// Design tokens for the Resonance settings window: palette, metrics, type scale.
#pragma once
#include "imgui.h"

namespace theme
{
    struct Palette
    {
        ImVec4 backdrop;       // behind the window (viewport clear)
        ImVec4 bg_root;        // shell / workspace
        ImVec4 bg_sidebar;
        ImVec4 bg_panel;       // cards
        ImVec4 bg_panel_alt;   // popups, raised surfaces
        ImVec4 bg_control;     // recessed fields, tracks
        ImVec4 bg_control_hi;  // hovered fields
        ImVec4 border_subtle;
        ImVec4 border_strong;
        ImVec4 divider;

        ImVec4 text_primary;
        ImVec4 text_secondary;
        ImVec4 text_muted;
        ImVec4 text_dim;

        ImVec4 accent;
        ImVec4 accent_hover;
        ImVec4 on_accent;
        ImVec4 success;
        ImVec4 warning;
    };

    struct Metrics
    {
        float scale;

        float radius_sm;    // checks, swatches
        float radius_md;    // fields, buttons
        float radius_lg;    // cards, popups
        float radius_xl;    // outer shell

        float gap_xs;       // 4
        float gap_sm;       // 8
        float gap_md;       // 12
        float gap_lg;       // 16
        float gap_xl;       // 20
        float gap_xxl;      // 24

        float control_h;    // combo / field height
        float row_h;        // single-line settings row
        float row_desc_h;   // settings row with helper text
        float slider_row_h; // label line + track
        float nav_h;
        float header_h;     // top bar

        float sidebar_w;
        float content_pad;
        float card_pad;
        float card_header_h;
        float card_min_w;

        float field_w;      // right-aligned combos / keybinds
        float toggle_w;
        float toggle_h;
        float track_h;
        float knob_r;
        float swatch;
        float icon;
        float stroke;
    };

    struct Type
    {
        ImFont* regular = nullptr;
        ImFont* medium = nullptr;
        ImFont* semibold = nullptr;

        // Unscaled pixel sizes; multiply by Metrics::scale when drawing.
        float title = 15.0f;   // brand / page title
        float body = 13.0f;    // control labels
        float value = 12.5f;   // values inside fields
        float small = 11.5f;   // helper text
        float caption = 10.5f; // uppercase section labels
    };

    void Init();                        // fonts + ImGuiStyle for infrastructure
    void SetScale(float scale);
    void SetAccent(const ImVec4& accent);

    const Palette& P();
    const Metrics& M();
    const Type& T();

    // Colour helpers (all honour ImGuiStyle::Alpha so page fades work everywhere)
    ImU32  Col(const ImVec4& c, float alpha_mul = 1.0f);
    ImVec4 Mix(const ImVec4& a, const ImVec4& b, float t);
    ImVec4 WithAlpha(const ImVec4& c, float a);
    ImVec4 Hex(unsigned int rgb, float a = 1.0f);
}
