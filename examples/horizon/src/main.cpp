// Horizon - a game settings menu (graphics, audio, controls, gameplay, profiles).
// Example project for ImGui Studio: theme/ holds the design tokens, widgets/ the ui:: control
// layer drawn with ImDrawList, and this file composes the window and its pages.
#include "imgui.h"
#include "imgui_internal.h"
#include "studio.h"
#include "studio_app.h"
#include "theme.h"
#include "ui.h"
#include <cmath>
#include <cstdio>

using namespace theme;

namespace
{
    enum Page { Page_Graphics, Page_Audio, Page_Controls, Page_Gameplay, Page_Profiles, Page_COUNT };

    struct State
    {
        int   page = Page_Graphics;
        float page_t = 1.0f;
        int   preset = 1;
        int   profile = 0;

        // Graphics
        int   display_mode = 0, resolution = 1, quality = 2, textures = 2, shadows = 1, aa = 2;
        bool  vsync = true, hdr = false, ambient_occlusion = true, motion_blur = false;
        float fps_cap = 144.0f, render_scale = 100.0f, fov = 90.0f, brightness = 50.0f;

        // Audio
        int   output = 0;
        float master = 80.0f, music = 45.0f, effects = 70.0f, voice = 85.0f, mic = 60.0f;
        bool  voice_chat = true, spatial = true, subtitles = false;
        ui::Keybind push_to_talk{ ImGuiKey_V };

        // Controls
        float sensitivity = 1.25f, aim_sensitivity = 0.8f;
        bool  invert_y = false, raw_input = true;
        ui::Keybind jump{ ImGuiKey_Space }, crouch{ ImGuiKey_LeftCtrl }, sprint{ ImGuiKey_LeftShift },
                    interact{ ImGuiKey_E }, reload{ ImGuiKey_R };

        // Gameplay
        bool  crosshair = true, fps_counter = false, damage_numbers = true, hit_markers = true, minimap_rotate = true;
        ImVec4 crosshair_colour = Hex(0x3DD68C), hit_colour = Hex(0xF0605A);
        int   crosshair_style = 0, difficulty = 1;
        float crosshair_size = 6.0f, hud_scale = 1.0f;

        // Interface
        ImVec4 accent = Hex(0x6C8CFF);
        float ui_scale = 1.0f, applied_scale = 1.0f;
        bool  reduced_motion = false;
    } S;

    const char* kPresets[]     = { "Performance", "Balanced", "Quality", "Custom" };
    const char* kDisplayMode[] = { "Fullscreen", "Borderless", "Windowed" };
    const char* kResolution[]  = { "1920 x 1080", "2560 x 1440", "3840 x 2160" };
    const char* kQuality[]     = { "Low", "Medium", "High", "Ultra" };
    const char* kShadows[]     = { "Off", "Low", "High" };
    const char* kAA[]          = { "Off", "FXAA", "TAA", "DLAA" };
    const char* kOutput[]      = { "System default", "Headphones", "Speakers" };
    const char* kCrosshair[]   = { "Cross", "Dot", "Circle" };
    const char* kDifficulty[]  = { "Story", "Normal", "Hard", "Veteran" };
    const char* kProfiles[]    = { "Default", "Competitive", "Streaming", "Laptop" };
    const char* kProfileMeta[] = { "Edited today", "2 days ago", "1 week ago", "3 weeks ago" };
    const ImVec4 kAccents[]    = { Hex(0x6C8CFF), Hex(0xF5A03A), Hex(0xF0605A), Hex(0xA78BFA), Hex(0x3DD68C) };

    struct Columns
    {
        ImVec2 origin;
        float  col_w, gap;
        bool   two;
        ImVec2 Col(int i, float stacked_y) const
        {
            if (two)
                return ImVec2(origin.x + i * (col_w + gap), origin.y);
            return ImVec2(origin.x, i == 0 ? origin.y : stacked_y + gap);
        }
    };

    Columns MakeColumns(ImVec2 origin, float width, float left_frac = 0.5f)
    {
        Columns c;
        c.origin = origin;
        c.gap = M.gap_md;
        c.two = width >= M.min_card_w * 2 + c.gap;
        c.col_w = c.two ? (width - c.gap) * left_frac : width;
        return c;
    }

    float CursorY() { return ImGui::GetCursorScreenPos().y; }

    // Two-column pages end both columns on the same line: last frame's tallest natural column
    // bottom (relative to the page origin) becomes the min height of each column's last card.
    float g_col_bottom[Page_COUNT];
    float EqualMinH(const Columns& c, float o_y)
    {
        float t = g_col_bottom[S.page];
        return (c.two && t > 0) ? o_y + t - CursorY() : 0.0f;
    }
    void StoreBottoms(const Columns& c, float o_y, float left, float right)
    {
        g_col_bottom[S.page] = c.two ? ImMax(left, right) - o_y : 0.0f;
    }

    // ------------------------------------------------------------------ pages

    void PageGraphics(ImVec2 o, float W)
    {
        STUDIO_SCOPE("graphics");
        Columns c = MakeColumns(o, W);
        ImGui::SetCursorScreenPos(c.Col(0, 0));
        ui::BeginCard("Display", c.col_w, EqualMinH(c, o.y));
        ui::Combo("Display mode", &S.display_mode, kDisplayMode, IM_ARRAYSIZE(kDisplayMode));
        ui::Combo("Resolution", &S.resolution, kResolution, IM_ARRAYSIZE(kResolution));
        ui::Toggle("VSync", &S.vsync);
        ui::Slider("Frame rate cap", &S.fps_cap, 30.0f, 240.0f, "%.0f fps");
        ui::Slider("Render scale", &S.render_scale, 50.0f, 200.0f, "%.0f%%");
        ui::Toggle("HDR", &S.hdr);
        ui::EndCard();
        float left_bottom = CursorY(), left_natural = ui::LastCardNaturalBottom();

        float right_w = c.two ? W - c.col_w - c.gap : W;
        ImVec2 r = c.Col(1, left_bottom);
        ImGui::SetCursorScreenPos(r);
        ui::BeginCard("Quality", right_w, 0, kPresets[S.preset]);
        ui::Combo("Overall quality", &S.quality, kQuality, IM_ARRAYSIZE(kQuality));
        ui::Combo("Textures", &S.textures, kQuality, IM_ARRAYSIZE(kQuality));
        ui::Combo("Shadows", &S.shadows, kShadows, IM_ARRAYSIZE(kShadows));
        ui::Combo("Anti-aliasing", &S.aa, kAA, IM_ARRAYSIZE(kAA));
        ui::EndCard();

        ImGui::SetCursorScreenPos(ImVec2(r.x, CursorY() + M.gap_md));
        ui::BeginCard("Camera", right_w, EqualMinH(c, o.y));
        ui::Slider("Field of view", &S.fov, 60.0f, 120.0f, "%.0f\xC2\xB0");
        ui::Slider("Brightness", &S.brightness, 0.0f, 100.0f, "%.0f");
        ui::Toggle("Ambient occlusion", &S.ambient_occlusion);
        ui::Toggle("Motion blur", &S.motion_blur);
        ui::EndCard();
        StoreBottoms(c, o.y, left_natural, ui::LastCardNaturalBottom());
    }

    void PageAudio(ImVec2 o, float W)
    {
        STUDIO_SCOPE("audio");
        Columns c = MakeColumns(o, W);
        ImGui::SetCursorScreenPos(c.Col(0, 0));
        ui::BeginCard("Volume", c.col_w, EqualMinH(c, o.y));
        ui::Combo("Output device", &S.output, kOutput, IM_ARRAYSIZE(kOutput));
        ui::Slider("Master", &S.master, 0.0f, 100.0f, "%.0f%%");
        ui::Slider("Music", &S.music, 0.0f, 100.0f, "%.0f%%");
        ui::Slider("Effects", &S.effects, 0.0f, 100.0f, "%.0f%%");
        ui::Slider("Dialogue", &S.voice, 0.0f, 100.0f, "%.0f%%");
        ui::EndCard();
        float left_bottom = CursorY(), left_natural = ui::LastCardNaturalBottom();

        float right_w = c.two ? W - c.col_w - c.gap : W;
        ImVec2 r = c.Col(1, left_bottom);
        ImGui::SetCursorScreenPos(r);
        ui::BeginCard("Voice chat", right_w, 0, S.voice_chat ? "On" : "Off");
        ui::Toggle("Enable voice chat", &S.voice_chat);
        ImGui::BeginDisabled(!S.voice_chat);
        ui::KeybindRow("Push to talk", &S.push_to_talk);
        ui::Slider("Mic sensitivity", &S.mic, 0.0f, 100.0f, "%.0f%%");
        ImGui::EndDisabled();
        ui::EndCard();

        ImGui::SetCursorScreenPos(ImVec2(r.x, CursorY() + M.gap_md));
        ui::BeginCard("Options", right_w, EqualMinH(c, o.y));
        ui::Toggle("Spatial audio", &S.spatial);
        ui::Toggle("Subtitles", &S.subtitles);
        ui::EndCard();
        StoreBottoms(c, o.y, left_natural, ui::LastCardNaturalBottom());
    }

    void PageControls(ImVec2 o, float W)
    {
        STUDIO_SCOPE("controls");
        Columns c = MakeColumns(o, W);
        ImGui::SetCursorScreenPos(c.Col(0, 0));
        ui::BeginCard("Mouse", c.col_w, EqualMinH(c, o.y));
        ui::Slider("Sensitivity", &S.sensitivity, 0.1f, 5.0f, "%.2f");
        ui::Slider("Aim sensitivity", &S.aim_sensitivity, 0.1f, 2.0f, "%.2fx");
        ui::Toggle("Invert Y axis", &S.invert_y);
        ui::Toggle("Raw input", &S.raw_input);
        ui::Helper("Raw input reads the mouse directly, ignoring OS acceleration.");
        ui::EndCard();
        float left_bottom = CursorY(), left_natural = ui::LastCardNaturalBottom();

        ImGui::SetCursorScreenPos(c.Col(1, left_bottom));
        ui::BeginCard("Key bindings", c.two ? W - c.col_w - c.gap : W, EqualMinH(c, o.y), "Click to rebind");
        ui::KeybindRow("Jump", &S.jump);
        ui::KeybindRow("Crouch", &S.crouch);
        ui::KeybindRow("Sprint", &S.sprint);
        ui::KeybindRow("Interact", &S.interact);
        ui::KeybindRow("Reload", &S.reload);
        ui::EndCard();
        StoreBottoms(c, o.y, left_natural, ui::LastCardNaturalBottom());
    }

    void PageGameplay(ImVec2 o, float W)
    {
        STUDIO_SCOPE("gameplay");
        Columns c = MakeColumns(o, W);
        ImGui::SetCursorScreenPos(c.Col(0, 0));
        ui::BeginCard("Crosshair", c.col_w, EqualMinH(c, o.y));
        ui::Toggle("Show crosshair", &S.crosshair, &S.crosshair_colour);
        ui::Combo("Style", &S.crosshair_style, kCrosshair, IM_ARRAYSIZE(kCrosshair));
        ui::Slider("Size", &S.crosshair_size, 2.0f, 20.0f, "%.0f px");
        ui::Toggle("Hit markers", &S.hit_markers, &S.hit_colour);
        ui::EndCard();
        float left_bottom = CursorY(), left_natural = ui::LastCardNaturalBottom();

        ImGui::SetCursorScreenPos(c.Col(1, left_bottom));
        ui::BeginCard("HUD", c.two ? W - c.col_w - c.gap : W, EqualMinH(c, o.y));
        ui::Combo("Difficulty", &S.difficulty, kDifficulty, IM_ARRAYSIZE(kDifficulty));
        ui::Slider("HUD scale", &S.hud_scale, 0.75f, 1.5f, "%.2fx");
        ui::Toggle("FPS counter", &S.fps_counter);
        ui::Toggle("Damage numbers", &S.damage_numbers);
        ui::Toggle("Rotate minimap", &S.minimap_rotate);
        ui::EndCard();
        StoreBottoms(c, o.y, left_natural, ui::LastCardNaturalBottom());
    }

    void PageProfiles(ImVec2 o, float W)
    {
        STUDIO_SCOPE("profiles");
        Columns c = MakeColumns(o, W);
        ImGui::SetCursorScreenPos(c.Col(0, 0));
        ui::BeginCard("Profiles", c.col_w, EqualMinH(c, o.y), "4 saved");
        float iw = ui::CardInnerWidth();
        for (int i = 0; i < IM_ARRAYSIZE(kProfiles); i++)
            if (ui::ListItem(kProfiles[i], kProfileMeta[i], S.profile == i, S.profile == i, iw))
                S.profile = i;
        ImGui::Dummy(ImVec2(iw, M.gap_md));
        float bw = (iw - M.gap_sm * 2) / 3.0f;
        ImVec2 bp = ImGui::GetCursorScreenPos();
        ui::Button("Load", ImVec2(bw, 30 * M.scale), true);
        ImGui::SetCursorScreenPos(ImVec2(bp.x + bw + M.gap_sm, bp.y));
        ui::Button("Save", ImVec2(bw, 30 * M.scale), false);
        ImGui::SetCursorScreenPos(ImVec2(bp.x + (bw + M.gap_sm) * 2, bp.y));
        ui::Button("New", ImVec2(bw, 30 * M.scale), false);
        ImGui::Dummy(ImVec2(iw, M.gap_sm));
        ui::EndCard();
        float left_bottom = CursorY(), left_natural = ui::LastCardNaturalBottom();

        ImGui::SetCursorScreenPos(c.Col(1, left_bottom));
        ui::BeginCard("Interface", c.two ? W - c.col_w - c.gap : W, EqualMinH(c, o.y));
        ui::AccentRow("Accent colour", &S.accent, kAccents, IM_ARRAYSIZE(kAccents));
        ui::Slider("Interface scale", &S.ui_scale, 0.85f, 1.25f, "%.2fx");
        ui::Toggle("Reduced motion", &S.reduced_motion);
        ui::EndCard();
        StoreBottoms(c, o.y, left_natural, ui::LastCardNaturalBottom());
    }

    // ------------------------------------------------------------------ shell

    void Sidebar(ImVec2 wp, float h)
    {
        STUDIO_SCOPE("nav");
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const float s = M.scale, x = wp.x + M.gap_md, w = M.sidebar_w - M.gap_md * 2;

        // Brand
        ImVec2 lp(x + M.gap_xs, wp.y + 18 * s);
        float ls = 30 * s;
        dl->AddRectFilled(lp, ImVec2(lp.x + ls, lp.y + ls), Col(Alpha(C.accent, 0.14f)), 8 * s);
        ui::DrawIcon(dl, ui::Icon::Logo, ImVec2(lp.x + ls * 0.5f, lp.y + ls * 0.5f), 17 * s, Col(C.accent));
        ui::Text(F.semibold, M.fs_brand, ImVec2(lp.x + ls + 10 * s, lp.y - 1 * s), C.text, "Horizon");
        ui::Text(F.regular, M.fs_micro, ImVec2(lp.x + ls + 10 * s, lp.y + 17 * s), C.text_muted, "Settings  \xC2\xB7  v1.0");
        ImGui::SetCursorScreenPos(wp);
        ImGui::InvisibleButton("##drag_brand", ImVec2(M.sidebar_w, 64 * s));
        if (ImGui::IsItemActive() && ImGui::IsMouseDragging(ImGuiMouseButton_Left, 0.0f))
            ImGui::SetWindowPos(ImVec2(ImGui::GetWindowPos().x + ImGui::GetIO().MouseDelta.x, ImGui::GetWindowPos().y + ImGui::GetIO().MouseDelta.y));

        struct NavDef { ui::Icon icon; const char* label; };
        const NavDef nav[Page_COUNT] = {
            { ui::Icon::Eye, "Graphics" },      { ui::Icon::Sliders, "Audio" },    { ui::Icon::Crosshair, "Controls" },
            { ui::Icon::Shield, "Gameplay" },   { ui::Icon::Folder, "Profiles" },
        };
        ImGui::SetCursorScreenPos(ImVec2(x, wp.y + 60 * s));
        for (int i = 0; i < Page_COUNT; i++)
        {
            if (i == 0) { ImGui::SetCursorScreenPos(ImVec2(x, CursorY())); ui::NavGroup("SETTINGS", w); }
            if (i == 4) { ImGui::SetCursorScreenPos(ImVec2(x, CursorY())); ui::NavGroup("ACCOUNT", w); }
            ImGui::SetCursorScreenPos(ImVec2(x, CursorY()));
            if (ui::NavItem(nav[i].icon, nav[i].label, S.page == i, w) && S.page != i)
            {
                S.page = i;
                S.page_t = 0.0f;
            }
            ImGui::Dummy(ImVec2(w, 2 * s));
        }

        // Player card pinned to the bottom
        float ch = 48 * s;
        ImVec2 cp(x, wp.y + h - M.gap_md - ch), cm(x + w, wp.y + h - M.gap_md);
        dl->AddRectFilled(cp, cm, Col(C.bg_panel), M.radius_md + 2 * s);
        dl->AddRect(cp, cm, Col(C.border), M.radius_md + 2 * s, 0, 1.0f);
        ImVec2 av(cp.x + 24 * s, cp.y + ch * 0.5f);
        dl->AddCircleFilled(av, 14 * s, Col(C.bg_control_hi), 24);
        ImVec2 is = ui::TextSize(F.semibold, M.fs_small, "P1");
        ui::Text(F.semibold, M.fs_small, ImVec2(av.x - is.x * 0.5f, av.y - is.y * 0.5f), C.text_label, "P1");
        dl->AddCircleFilled(ImVec2(av.x + 10 * s, av.y + 10 * s), 4.5f * s, Col(C.bg_panel), 12);
        dl->AddCircleFilled(ImVec2(av.x + 10 * s, av.y + 10 * s), 3 * s, Col(C.success), 12);
        ui::Text(F.medium, M.fs_body, ImVec2(av.x + 22 * s, cp.y + 9 * s), C.text, "Player One");
        ui::Text(F.regular, M.fs_micro, ImVec2(av.x + 22 * s, cp.y + 26 * s), C.text_muted, "Online");
        STUDIO_REGION("nav.account", cp, cm);
    }

    void TopBar(ImVec2 wp, float w)
    {
        STUDIO_SCOPE("top");
        static const char* titles[Page_COUNT] = { "Graphics", "Audio", "Controls", "Gameplay", "Profiles" };
        static const char* crumbs[Page_COUNT] = { "Settings", "Settings", "Settings", "Settings", "Account" };
        const float s = M.scale, x0 = wp.x + M.sidebar_w + M.content_pad, right = wp.x + w - M.content_pad;
        ImDrawList* dl = ImGui::GetWindowDrawList();

        ui::Text(F.regular, M.fs_small, ImVec2(x0, wp.y + 11 * s), C.text_dim, crumbs[S.page]);
        ui::Text(F.semibold, M.fs_title, ImVec2(x0, wp.y + 26 * s), C.text, titles[S.page]);

        // Preset selector
        float cw = 128 * s, cy = wp.y + (M.header_h - M.control_h) * 0.5f;
        ui::ComboField("Preset", &S.preset, kPresets, IM_ARRAYSIZE(kPresets), ImVec2(right - cw, cy), cw);

        // Save status pill
        const char* st = "All changes saved";
        ImVec2 ts = ui::TextSize(F.medium, M.fs_small, st);
        float pw = ts.x + 34 * s, px = right - cw - M.gap_sm - pw;
        ImVec2 pa(px, cy), pb(px + pw, cy + M.control_h);
        dl->AddRectFilled(pa, pb, Col(Alpha(C.success, 0.08f)), M.control_h * 0.5f);
        dl->AddRect(pa, pb, Col(Alpha(C.success, 0.18f)), M.control_h * 0.5f, 0, 1.0f);
        dl->AddCircleFilled(ImVec2(pa.x + 13 * s, cy + M.control_h * 0.5f), 3 * s, Col(C.success), 12);
        ui::Text(F.medium, M.fs_small, ImVec2(pa.x + 23 * s, cy + (M.control_h - M.fs_small) * 0.5f - 1), C.text_label, st);
        STUDIO_REGION("top.status", pa, pb);

        // Drag handle across the title area
        ImGui::SetCursorScreenPos(ImVec2(wp.x + M.sidebar_w, wp.y));
        ImGui::InvisibleButton("##drag", ImVec2(ImMax(1.0f, px - M.gap_md - (wp.x + M.sidebar_w)), M.header_h));
        if (ImGui::IsItemActive() && ImGui::IsMouseDragging(ImGuiMouseButton_Left, 0.0f))
            ImGui::SetWindowPos(ImVec2(ImGui::GetWindowPos().x + ImGui::GetIO().MouseDelta.x, ImGui::GetWindowPos().y + ImGui::GetIO().MouseDelta.y));
    }
}

void AppInit()
{
    theme::Init();
}

void AppFrame()
{
    // Apply interface settings between frames so a slider drag never rescales mid-widget.
    if (S.ui_scale != S.applied_scale && !ImGui::IsAnyItemActive())
    {
        S.applied_scale = S.ui_scale;
        theme::SetScale(S.ui_scale);
    }
    theme::SetAccent(S.accent);
    ui::SetReducedMotion(S.reduced_motion);

    ImGuiIO& io = ImGui::GetIO();
    const float s = M.scale;
    ImVec2 size(ImMin(880 * s, io.DisplaySize.x - 16), ImMin(540 * s, io.DisplaySize.y - 16));
    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x * 0.5f, io.DisplaySize.y * 0.5f), ImGuiCond_FirstUseEver, ImVec2(0.5f, 0.5f));
    ImGui::SetNextWindowSize(size);
    ImGui::Begin("Horizon", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoScrollbar |
                     ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_NoSavedSettings);
    ImVec2 wp = ImGui::GetWindowPos();
    ImDrawList* dl = ImGui::GetWindowDrawList();

    // Shell: root surface, sidebar, hairline dividers
    ImVec2 wm(wp.x + size.x, wp.y + size.y);
    dl->AddRectFilled(wp, wm, Col(C.bg_root), M.radius_lg + 2 * s);
    dl->AddRectFilled(wp, ImVec2(wp.x + M.sidebar_w, wm.y), Col(C.bg_sidebar), M.radius_lg + 2 * s, ImDrawFlags_RoundCornersLeft);
    dl->AddLine(ImVec2(wp.x + M.sidebar_w, wp.y), ImVec2(wp.x + M.sidebar_w, wm.y), Col(C.border));
    dl->AddLine(ImVec2(wp.x + M.sidebar_w, wp.y + M.header_h), ImVec2(wm.x, wp.y + M.header_h), Col(C.border));
    dl->AddRect(wp, wm, Col(Alpha(C.border, 0.7f)), M.radius_lg + 2 * s, 0, 1.0f);
    STUDIO_REGION("shell", wp, wm);

    Sidebar(wp, size.y);
    TopBar(wp, size.x);

    // Workspace with page fade + slight rise (180 ms ease-out cubic)
    S.page_t = ImMin(1.0f, S.page_t + io.DeltaTime / (S.reduced_motion ? 0.001f : 0.18f));
    float e = 1.0f - powf(1.0f - S.page_t, 3.0f);
    ImGui::SetCursorScreenPos(ImVec2(wp.x + M.sidebar_w + 1, wp.y + M.header_h + 1));
    ImGui::BeginChild("##workspace", ImVec2(size.x - M.sidebar_w - 2, size.y - M.header_h - 2), 0, ImGuiWindowFlags_NoBackground);
    STUDIO_STATE("page_fade", e);
    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, e);
    ImVec2 cp = ImGui::GetCursorScreenPos();
    ImVec2 o(cp.x + M.content_pad - 1, cp.y + M.content_pad - 1 + (1.0f - e) * 6 * s);
    float W = ImGui::GetContentRegionAvail().x - M.content_pad * 2 + 2;
    switch (S.page)
    {
    case Page_Graphics: PageGraphics(o, W); break;
    case Page_Audio:    PageAudio(o, W); break;
    case Page_Controls: PageControls(o, W); break;
    case Page_Gameplay: PageGameplay(o, W); break;
    case Page_Profiles: PageProfiles(o, W); break;
    }
    ImGui::Dummy(ImVec2(W, M.content_pad));
    ImGui::PopStyleVar();
    ImGui::EndChild();
    ImGui::End();
}
