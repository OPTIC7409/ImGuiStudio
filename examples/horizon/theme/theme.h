// Design tokens: colours, metrics (DPI-scaled), fonts and type scale.
#pragma once
#include "imgui.h"

namespace theme
{
    struct Colors
    {
        ImVec4 bg_root, bg_sidebar, bg_panel, bg_panel_alt, bg_control, bg_control_hi, bg_track;
        ImVec4 border, border_strong, divider;
        ImVec4 text, text_label, text_muted, text_dim;
        ImVec4 accent, accent_hover;
        ImVec4 success, danger;
    };

    struct Metrics
    {
        float scale;
        float radius_sm, radius_md, radius_lg;
        float gap_xs, gap_sm, gap_md, gap_lg, gap_xl;
        float row_h, slider_row_h, control_h, nav_h, list_h, header_h;
        float sidebar_w, content_pad, card_pad, card_header_h, min_card_w;
        float toggle_w, toggle_h, combo_w, swatch, stroke;
        float fs_brand, fs_title, fs_body, fs_small, fs_micro;
    };

    struct Fonts
    {
        ImFont* regular;
        ImFont* medium;
        ImFont* semibold;
    };

    extern Colors  C;
    extern Metrics M;
    extern Fonts   F;

    void   Init();                    // fonts + style, call once from AppInit
    void   SetScale(float scale);     // rebuilds metrics and style sizes
    void   SetAccent(const ImVec4& accent);

    ImVec4 Hex(unsigned rgb, float a = 1.0f);
    ImVec4 Mix(const ImVec4& a, const ImVec4& b, float t);
    ImVec4 Alpha(const ImVec4& c, float a);
    ImU32  Col(const ImVec4& c, float alpha_mul = 1.0f); // honours style.Alpha (page fades, disabled)
}
