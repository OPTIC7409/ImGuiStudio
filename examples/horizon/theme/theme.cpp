#include "theme.h"
#include <cstdio>

namespace theme
{
    Colors  C;
    Metrics M;
    Fonts   F;

    ImVec4 Hex(unsigned rgb, float a)
    {
        return ImVec4(((rgb >> 16) & 0xFF) / 255.0f, ((rgb >> 8) & 0xFF) / 255.0f, (rgb & 0xFF) / 255.0f, a);
    }

    ImVec4 Mix(const ImVec4& a, const ImVec4& b, float t)
    {
        return ImVec4(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t);
    }

    ImVec4 Alpha(const ImVec4& c, float a) { return ImVec4(c.x, c.y, c.z, c.w * a); }

    ImU32 Col(const ImVec4& c, float alpha_mul)
    {
        return ImGui::GetColorU32(ImVec4(c.x, c.y, c.z, c.w * alpha_mul));
    }

    void SetAccent(const ImVec4& accent)
    {
        C.accent = accent;
        C.accent_hover = Mix(accent, ImVec4(1, 1, 1, 1), 0.12f);
    }

    void SetScale(float s)
    {
        M.scale = s;
        M.radius_sm = 4 * s;  M.radius_md = 6 * s;  M.radius_lg = 10 * s;
        M.gap_xs = 4 * s;  M.gap_sm = 8 * s;  M.gap_md = 12 * s;  M.gap_lg = 16 * s;  M.gap_xl = 20 * s;
        M.row_h = 34 * s;  M.slider_row_h = 48 * s;  M.control_h = 26 * s;
        M.nav_h = 34 * s;  M.list_h = 30 * s;  M.header_h = 56 * s;
        M.sidebar_w = 196 * s;  M.content_pad = 20 * s;  M.card_pad = 14 * s;
        M.card_header_h = 22 * s;  M.min_card_w = 280 * s;
        M.toggle_w = 30 * s;  M.toggle_h = 16 * s;  M.combo_w = 136 * s;  M.swatch = 14 * s;
        M.stroke = 1.5f * s;
        M.fs_brand = 15 * s;  M.fs_title = 15 * s;  M.fs_body = 13 * s;  M.fs_small = 11.5f * s;  M.fs_micro = 10.5f * s;

        ImGuiStyle& st = ImGui::GetStyle();
        st.WindowPadding = ImVec2(0, 0);
        st.ItemSpacing = ImVec2(0, 0);
        st.ItemInnerSpacing = ImVec2(0, 0);
        st.FramePadding = ImVec2(0, 0);
        st.WindowBorderSize = 0;
        st.ChildBorderSize = 0;
        st.PopupBorderSize = 1;
        st.WindowRounding = M.radius_lg;
        st.PopupRounding = 8 * s;
        st.ScrollbarSize = 6 * s;
        st.ScrollbarRounding = 3 * s;
        st.DisabledAlpha = 0.38f;
        st.WindowMinSize = ImVec2(1, 1);
    }

    static ImFont* LoadFont(const char* path, float size)
    {
        if (FILE* f = fopen(path, "rb"))
        {
            fclose(f);
            return ImGui::GetIO().Fonts->AddFontFromFileTTF(path, size);
        }
        return nullptr;
    }

    void Init()
    {
        C.bg_root       = Hex(0x0C0D11);
        C.bg_sidebar    = Hex(0x0F1015);
        C.bg_panel      = Hex(0x14151B);
        C.bg_panel_alt  = Hex(0x191A21);
        C.bg_control    = Hex(0x1C1D25);
        C.bg_control_hi = Hex(0x23252E);
        C.bg_track      = Hex(0x262833);
        C.border        = Hex(0x22242D);
        C.border_strong = Hex(0x30323D);
        C.divider       = Hex(0x1E2028);
        C.text          = Hex(0xEEF0F4);
        C.text_label    = Hex(0xC3C6D0);
        C.text_muted    = Hex(0x868999);
        C.text_dim      = Hex(0x5B5E6C);
        C.success       = Hex(0x3DD68C);
        C.danger        = Hex(0xF0605A);
        SetAccent(Hex(0x6C8CFF)); // periwinkle blue

        ImGuiIO& io = ImGui::GetIO();
        io.IniFilename = nullptr;
        F.regular  = LoadFont("assets/fonts/Inter-Regular.ttf", 13.0f);
        F.medium   = LoadFont("assets/fonts/Inter-Medium.ttf", 13.0f);
        F.semibold = LoadFont("assets/fonts/Inter-SemiBold.ttf", 13.0f);
        if (!F.regular)
            F.regular = io.Fonts->AddFontDefault();
        if (!F.medium)   F.medium = F.regular;
        if (!F.semibold) F.semibold = F.medium;
        io.FontDefault = F.regular;

        ImGuiStyle& st = ImGui::GetStyle();
        ImVec4* c = st.Colors;
        c[ImGuiCol_WindowBg]             = C.bg_root;
        c[ImGuiCol_ChildBg]              = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_PopupBg]              = C.bg_panel_alt;
        c[ImGuiCol_Border]               = C.border_strong;
        c[ImGuiCol_Text]                 = C.text;
        c[ImGuiCol_ScrollbarBg]          = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_ScrollbarGrab]        = C.bg_track;
        c[ImGuiCol_ScrollbarGrabHovered] = C.border_strong;
        c[ImGuiCol_ScrollbarGrabActive]  = C.text_dim;
        c[ImGuiCol_NavCursor]            = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_ModalWindowDimBg]     = ImVec4(0, 0, 0, 0);
        SetScale(1.0f);
    }
}
