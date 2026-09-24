#include "theme.hpp"

#include <cstdio>

namespace theme
{
    const ImVec4 kAccents[6] =
    {
        ImVec4(0.427f, 0.365f, 0.988f, 1.0f),   // violet  #6D5DFC
        ImVec4(0.231f, 0.510f, 0.965f, 1.0f),   // blue    #3B82F6
        ImVec4(0.078f, 0.722f, 0.651f, 1.0f),   // teal    #14B8A6
        ImVec4(0.925f, 0.282f, 0.600f, 1.0f),   // pink    #EC4899
        ImVec4(0.976f, 0.451f, 0.086f, 1.0f),   // orange  #F97316
        ImVec4(0.518f, 0.800f, 0.086f, 1.0f),   // lime    #84CC16
    };
    const char* const kAccentNames[6] = { "Violet", "Blue", "Teal", "Pink", "Orange", "Lime" };

    namespace
    {
        Palette g_Palette;
        Fonts   g_Fonts;

        ImVec4 Hex(unsigned int rgb, float a = 1.0f)
        {
            return ImVec4(((rgb >> 16) & 0xFF) / 255.0f, ((rgb >> 8) & 0xFF) / 255.0f, (rgb & 0xFF) / 255.0f, a);
        }

        ImFont* LoadFont(const char* path)
        {
            // Check first so a missing file falls back to the default font instead of asserting.
            if (FILE* f = fopen(path, "rb"))
            {
                fclose(f);
                ImFontConfig cfg;
                cfg.OversampleH = 2;
                cfg.PixelSnapH = false;
                return ImGui::GetIO().Fonts->AddFontFromFileTTF(path, kBody, &cfg);
            }
            return nullptr;
        }
    }

    void SetAccentColor(const ImVec4& c)
    {
        g_Palette.accent = c;
        g_Palette.accentSoft = ImVec4(c.x, c.y, c.z, 0.16f);
        ImGuiStyle& s = ImGui::GetStyle();
        s.Colors[ImGuiCol_CheckMark] = c;
        s.Colors[ImGuiCol_SliderGrab] = c;
        s.Colors[ImGuiCol_SliderGrabActive] = c;
        s.Colors[ImGuiCol_TextSelectedBg] = ImVec4(c.x, c.y, c.z, 0.35f);
        s.Colors[ImGuiCol_NavCursor] = c;
    }

    void SetAccent(int index)
    {
        SetAccentColor(kAccents[(index % 6 + 6) % 6]);
    }

    const Palette& Colors() { return g_Palette; }
    const Fonts& Font() { return g_Fonts; }

    ImU32 Col(const ImVec4& c, float alpha_mul)
    {
        return ImGui::GetColorU32(ImVec4(c.x, c.y, c.z, c.w * alpha_mul));
    }

    void Init()
    {
        Palette& p = g_Palette;
        p.backdrop = Hex(0x07080C);
        p.window = Hex(0x111319);
        p.sidebar = Hex(0x0D0F14);
        p.card = Hex(0x161920);
        p.cardBorder = Hex(0x232733);
        p.control = Hex(0x232834);
        p.controlHover = Hex(0x2B3140);
        p.divider = Hex(0x1E222C);
        p.text = Hex(0xE8EAF0);
        p.textDim = Hex(0x9097A8);
        p.textFaint = Hex(0x5E6475);
        p.success = Hex(0x22C55E);
        p.danger = Hex(0xF43F5E);

        ImGuiIO& io = ImGui::GetIO();
        g_Fonts.regular = LoadFont("assets/fonts/Inter-Regular.ttf");
        g_Fonts.medium = LoadFont("assets/fonts/Inter-Medium.ttf");
        g_Fonts.semibold = LoadFont("assets/fonts/Inter-SemiBold.ttf");
        if (!g_Fonts.regular)
            g_Fonts.regular = io.Fonts->AddFontDefault();
        if (!g_Fonts.medium)
            g_Fonts.medium = g_Fonts.regular;
        if (!g_Fonts.semibold)
            g_Fonts.semibold = g_Fonts.medium;
        io.FontDefault = g_Fonts.regular;

        ImGuiStyle& s = ImGui::GetStyle();
        s = ImGuiStyle();
        s.FontSizeBase = kBody;
        s.WindowPadding = ImVec2(0, 0);
        s.WindowRounding = 14.0f;
        s.WindowBorderSize = 0.0f;
        s.ChildRounding = kRadius;
        s.ChildBorderSize = 0.0f;
        s.PopupRounding = 10.0f;
        s.PopupBorderSize = 1.0f;
        s.FramePadding = ImVec2(10, 7);
        s.FrameRounding = 8.0f;
        s.ItemSpacing = ImVec2(10, 8);
        s.ItemInnerSpacing = ImVec2(8, 6);
        s.ScrollbarSize = 10.0f;
        s.ScrollbarRounding = 8.0f;
        s.GrabRounding = 6.0f;
        s.GrabMinSize = 10.0f;

        ImVec4* c = s.Colors;
        c[ImGuiCol_Text] = p.text;
        c[ImGuiCol_TextDisabled] = p.textFaint;
        c[ImGuiCol_WindowBg] = p.window;
        c[ImGuiCol_ChildBg] = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_PopupBg] = Hex(0x1A1E27);
        c[ImGuiCol_Border] = p.cardBorder;
        c[ImGuiCol_FrameBg] = p.control;
        c[ImGuiCol_FrameBgHovered] = p.controlHover;
        c[ImGuiCol_FrameBgActive] = p.controlHover;
        c[ImGuiCol_ScrollbarBg] = ImVec4(0, 0, 0, 0);
        c[ImGuiCol_ScrollbarGrab] = Hex(0x262B37);
        c[ImGuiCol_ScrollbarGrabHovered] = Hex(0x323847);
        c[ImGuiCol_ScrollbarGrabActive] = Hex(0x3A4152);
        c[ImGuiCol_Button] = p.control;
        c[ImGuiCol_ButtonHovered] = p.controlHover;
        c[ImGuiCol_ButtonActive] = Hex(0x343B4C);
        c[ImGuiCol_Header] = p.control;
        c[ImGuiCol_HeaderHovered] = p.controlHover;
        c[ImGuiCol_HeaderActive] = p.controlHover;
        c[ImGuiCol_Separator] = p.divider;
        c[ImGuiCol_ModalWindowDimBg] = ImVec4(0, 0, 0, 0.55f);
        SetAccent(0);
    }
}
