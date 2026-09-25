#include "theme.h"
#include <cstdio>

namespace theme
{
    namespace
    {
        Palette g_P;
        Metrics g_M;
        Type    g_T;

        ImFont* LoadFont(const char* path, float size)
        {
            if (FILE* f = std::fopen(path, "rb"))
            {
                std::fclose(f);
                return ImGui::GetIO().Fonts->AddFontFromFileTTF(path, size);
            }
            return nullptr;
        }

        void BuildPalette(const ImVec4& accent)
        {
            g_P.backdrop       = Hex(0x07080B);
            g_P.bg_root        = Hex(0x0D0E13);
            g_P.bg_sidebar     = Hex(0x101117);
            g_P.bg_panel       = Hex(0x14151C);
            g_P.bg_panel_alt   = Hex(0x191A23);
            g_P.bg_control     = Hex(0x1C1D27);
            g_P.bg_control_hi  = Hex(0x22232F);
            g_P.border_subtle  = Hex(0x22242E);
            g_P.border_strong  = Hex(0x2E303D);
            g_P.divider        = Hex(0x1D1F28);

            g_P.text_primary   = Hex(0xF1F2F6);
            g_P.text_secondary = Hex(0xC3C5D0);
            g_P.text_muted     = Hex(0x858899);
            g_P.text_dim       = Hex(0x5E6170);

            g_P.accent         = accent;
            g_P.accent_hover   = Mix(accent, ImVec4(1, 1, 1, 1), 0.12f);
            g_P.on_accent      = Hex(0xFFFFFF);
            g_P.success        = Hex(0x3FCF8E);
            g_P.warning        = Hex(0xF2B45A);
        }
    }

    ImVec4 Hex(unsigned int rgb, float a)
    {
        return ImVec4(((rgb >> 16) & 0xFF) / 255.0f, ((rgb >> 8) & 0xFF) / 255.0f, (rgb & 0xFF) / 255.0f, a);
    }

    ImU32 Col(const ImVec4& c, float alpha_mul)
    {
        return ImGui::GetColorU32(ImVec4(c.x, c.y, c.z, c.w * alpha_mul));
    }

    ImVec4 Mix(const ImVec4& a, const ImVec4& b, float t)
    {
        return ImVec4(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t);
    }

    ImVec4 WithAlpha(const ImVec4& c, float a) { return ImVec4(c.x, c.y, c.z, a); }

    const Palette& P() { return g_P; }
    const Metrics& M() { return g_M; }
    const Type&    T() { return g_T; }

    void SetAccent(const ImVec4& accent) { BuildPalette(accent); }

    void SetScale(float s)
    {
        Metrics& m = g_M;
        m.scale = s;

        m.radius_sm = 3.0f * s;
        m.radius_md = 6.0f * s;
        m.radius_lg = 8.0f * s;
        m.radius_xl = 12.0f * s;

        m.gap_xs  = 4.0f * s;
        m.gap_sm  = 8.0f * s;
        m.gap_md  = 12.0f * s;
        m.gap_lg  = 16.0f * s;
        m.gap_xl  = 20.0f * s;
        m.gap_xxl = 24.0f * s;

        m.control_h    = 28.0f * s;
        m.row_h        = 38.0f * s;
        m.row_desc_h   = 48.0f * s;
        m.slider_row_h = 52.0f * s;
        m.nav_h        = 34.0f * s;
        m.header_h     = 60.0f * s;

        m.sidebar_w     = 200.0f * s;
        m.content_pad   = 20.0f * s;
        m.card_pad      = 16.0f * s;
        m.card_header_h = 36.0f * s;
        m.card_min_w    = 280.0f * s;

        m.field_w  = 156.0f * s;
        m.toggle_w = 30.0f * s;
        m.toggle_h = 16.0f * s;
        m.track_h  = 4.0f * s;
        m.knob_r   = 6.0f * s;
        m.swatch   = 14.0f * s;
        m.icon     = 16.0f * s;
        m.stroke   = 1.5f * s;

        ImGuiStyle& st = ImGui::GetStyle();
        st.ScrollbarSize = 6.0f * s;
        st.ScrollbarRounding = 3.0f * s;
    }

    void Init()
    {
        ImGuiIO& io = ImGui::GetIO();
        g_T.regular  = LoadFont("assets/fonts/Inter-Regular.ttf", 13.0f);
        g_T.medium   = LoadFont("assets/fonts/Inter-Medium.ttf", 13.0f);
        g_T.semibold = LoadFont("assets/fonts/Inter-SemiBold.ttf", 13.0f);
        if (!g_T.regular)
            g_T.regular = io.Fonts->AddFontDefault();
        if (!g_T.medium)   g_T.medium = g_T.regular;
        if (!g_T.semibold) g_T.semibold = g_T.medium;
        io.FontDefault = g_T.regular;

        BuildPalette(Hex(0x6C60FF));

        // The stock style only shows through infrastructure (child windows,
        // popup shells, scrollbars): make all of it match the tokens.
        ImGuiStyle& st = ImGui::GetStyle();
        st.WindowPadding = ImVec2(0, 0);
        st.WindowBorderSize = 0.0f;
        st.ChildBorderSize = 0.0f;
        st.PopupBorderSize = 1.0f;
        st.PopupRounding = 8.0f;
        st.FramePadding = ImVec2(0, 0);
        st.ItemSpacing = ImVec2(0, 0);
        st.ItemInnerSpacing = ImVec2(0, 0);
        st.WindowRounding = 0.0f;
        st.ChildRounding = 0.0f;

        ImVec4* c = st.Colors;
        c[ImGuiCol_WindowBg]             = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_ChildBg]              = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_PopupBg]              = g_P.bg_panel_alt;
        c[ImGuiCol_Border]               = g_P.border_strong;
        c[ImGuiCol_Text]                 = g_P.text_primary;
        c[ImGuiCol_TextSelectedBg]       = WithAlpha(g_P.accent, 0.35f);
        c[ImGuiCol_ScrollbarBg]          = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_ScrollbarGrab]        = Hex(0x2A2C38);
        c[ImGuiCol_ScrollbarGrabHovered] = Hex(0x363848);
        c[ImGuiCol_ScrollbarGrabActive]  = Hex(0x424557);
        c[ImGuiCol_NavCursor]            = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_ModalWindowDimBg]     = ImVec4(0, 0, 0, 0);

        SetScale(1.0f);
    }
}
