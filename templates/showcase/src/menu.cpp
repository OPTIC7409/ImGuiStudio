// menu.cpp - "Nova" control center: a fully custom settings UI built on Dear ImGui.
#include "menu.hpp"

#include "anim.hpp"
#include "settings.hpp"
#include "theme.hpp"
#include "widgets.hpp"

#include "imgui.h"
#include "imgui_internal.h"
#include "studio.h"

#include <cmath>
#include <cstdio>

bool Settings::operator==(const Settings& o) const
{
    return language == o.language && launchOnStartup == o.launchOnStartup && minimizeToTray == o.minimizeToTray && updates == o.updates &&
           notifications == o.notifications && notificationSounds == o.notificationSounds && doNotDisturb == o.doNotDisturb &&
           resolution == o.resolution && displayMode == o.displayMode && vsync == o.vsync && fpsLimit == o.fpsLimit && preset == o.preset &&
           renderScale == o.renderScale && antiAliasing == o.antiAliasing && shadows == o.shadows && motionBlur == o.motionBlur && bloom == o.bloom &&
           outputDevice == o.outputDevice && masterVolume == o.masterVolume && musicVolume == o.musicVolume && effectsVolume == o.effectsVolume &&
           voiceVolume == o.voiceVolume && muteUnfocused == o.muteUnfocused && spatialAudio == o.spatialAudio && dynamicRange == o.dynamicRange &&
           keyForward == o.keyForward && keyBack == o.keyBack && keyLeft == o.keyLeft && keyRight == o.keyRight && keyJump == o.keyJump &&
           keyInteract == o.keyInteract && sensitivity == o.sensitivity && invertY == o.invertY && rawInput == o.rawInput && accent == o.accent &&
           reduceMotion == o.reduceMotion && compactSidebar == o.compactSidebar;
}

namespace
{
    struct Page
    {
        const char* name;
        ui::Icon icon;
        const char* subtitle;
    };

    const Page kPages[] =
    {
        { "General", ui::Icon::General, "Startup, updates and notifications" },
        { "Graphics", ui::Icon::Monitor, "Display, quality and performance" },
        { "Audio", ui::Icon::Speaker, "Output device and mix" },
        { "Controls", ui::Icon::Keyboard, "Key bindings and mouse" },
        { "Appearance", ui::Icon::Palette, "Accent colour and motion" },
    };
    constexpr int kPageCount = IM_ARRAYSIZE(kPages);

    const ImVec2 kWindowSize(1000.0f, 700.0f);
    constexpr float kSidebarWide = 228.0f;
    constexpr float kSidebarCompact = 76.0f;
    constexpr float kHeaderH = 84.0f;
    constexpr float kFooterH = 70.0f;

    Settings g_Settings;
    Settings g_Applied;
    int      g_Page = 1;
    char     g_Search[64] = "";
    float    g_FrameTimes[96];
    int      g_FrameIndex = 0;
    double   g_FrameAccum = 0.0;
    float    g_Indicator = -1.0f;
    float    g_SidebarW = kSidebarWide;
    float    g_PageFade = 1.0f;
    int      g_LastPage = -1;

    // Deterministic pseudo frame times (so captures are reproducible).
    float FakeFrameTime(int i)
    {
        unsigned int h = (unsigned int)i * 2654435761u;
        h ^= h >> 13;
        h *= 0x5bd1e995u;
        h ^= h >> 15;
        const float noise = (h & 1023u) / 1023.0f;
        float v = 6.8f + 0.55f * sinf(i * 0.21f) + 0.35f * sinf(i * 0.53f + 1.3f) + noise * 0.45f;
        if ((h >> 10) % 29u == 0u)
            v += 3.2f;
        return v;
    }

    void UpdateFrameTimes()
    {
        g_FrameAccum += ImGui::GetIO().DeltaTime;
        while (g_FrameAccum >= 1.0 / 12.0)
        {
            g_FrameAccum -= 1.0 / 12.0;
            for (int i = 0; i < IM_ARRAYSIZE(g_FrameTimes) - 1; i++)
                g_FrameTimes[i] = g_FrameTimes[i + 1];
            g_FrameTimes[IM_ARRAYSIZE(g_FrameTimes) - 1] = FakeFrameTime(g_FrameIndex++);
        }
    }

    void RadialGlow(ImDrawList* dl, const ImVec2& center, float radius, const ImVec4& color)
    {
        const int segments = 64;
        const ImVec2 uv = ImGui::GetFontTexUvWhitePixel();
        const ImU32 inner = ImGui::GetColorU32(color);
        const ImU32 outer = ImGui::GetColorU32(ImVec4(color.x, color.y, color.z, 0.0f));
        dl->PrimReserve(segments * 3, segments + 1);
        const ImDrawIdx base = (ImDrawIdx)dl->_VtxCurrentIdx;
        dl->PrimWriteVtx(center, uv, inner);
        for (int i = 0; i < segments; i++)
        {
            const float a = (float)i / segments * 6.2831853f;
            dl->PrimWriteVtx(ImVec2(center.x + cosf(a) * radius, center.y + sinf(a) * radius), uv, outer);
        }
        for (int i = 0; i < segments; i++)
        {
            dl->PrimWriteIdx(base);
            dl->PrimWriteIdx((ImDrawIdx)(base + 1 + i));
            dl->PrimWriteIdx((ImDrawIdx)(base + 1 + (i + 1) % segments));
        }
    }

    void DrawBackdrop(const ImGuiViewport* vp, const ImVec2& pos, const ImVec2& size)
    {
        const theme::Palette& c = theme::Colors();
        ImDrawList* bg = ImGui::GetBackgroundDrawList();
        bg->AddRectFilled(vp->Pos, ImVec2(vp->Pos.x + vp->Size.x, vp->Pos.y + vp->Size.y), theme::Col(c.backdrop));
        RadialGlow(bg, ImVec2(pos.x + size.x * 0.12f, pos.y + size.y * 0.05f), 560.0f, ImVec4(c.accent.x, c.accent.y, c.accent.z, 0.22f));
        RadialGlow(bg, ImVec2(pos.x + size.x * 1.02f, pos.y + size.y * 1.05f), 480.0f, ImVec4(0.08f, 0.72f, 0.65f, 0.10f));
        for (float y = vp->Pos.y + 12.0f; y < vp->Pos.y + vp->Size.y; y += 24.0f)
            for (float x = vp->Pos.x + 12.0f; x < vp->Pos.x + vp->Size.x; x += 24.0f)
                bg->AddRectFilled(ImVec2(x, y), ImVec2(x + 1.0f, y + 1.0f), IM_COL32(255, 255, 255, 10));
        ui::SoftShadow(bg, pos, ImVec2(pos.x + size.x, pos.y + size.y), 14.0f, 44.0f, IM_COL32(0, 0, 0, 255));
    }

    // ------------------------------------------------------------------------
    // Sidebar
    // ------------------------------------------------------------------------
    void Sidebar(const ImVec2& wpos)
    {
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        const float target = g_Settings.compactSidebar ? kSidebarCompact : kSidebarWide;
        g_SidebarW = anim::Approach(g_SidebarW, target, 0.22f * ui::MotionScale());
        const float wide = ImClamp((g_SidebarW - kSidebarCompact) / (kSidebarWide - kSidebarCompact), 0.0f, 1.0f);

        ImDrawList* wdl = ImGui::GetWindowDrawList();
        wdl->AddRectFilled(wpos, ImVec2(wpos.x + g_SidebarW, wpos.y + kWindowSize.y), theme::Col(c.sidebar), 14.0f, ImDrawFlags_RoundCornersLeft);
        wdl->AddLine(ImVec2(wpos.x + g_SidebarW, wpos.y), ImVec2(wpos.x + g_SidebarW, wpos.y + kWindowSize.y), theme::Col(c.divider), 1.0f);

        ImGui::SetCursorScreenPos(wpos);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(14.0f, 18.0f));
        ImGui::BeginChild("##sidebar", ImVec2(g_SidebarW, kWindowSize.y), ImGuiChildFlags_AlwaysUseWindowPadding, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
        ImGui::PopStyleVar();
        STUDIO_SCOPE("sidebar");
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 origin = ImGui::GetWindowPos();

        // Brand
        const ImVec2 p = ImGui::GetCursorScreenPos();
        const ImVec2 lmin(p.x + 6.0f, p.y + 2.0f);
        const ImVec2 lmax(lmin.x + 36.0f, lmin.y + 36.0f);
        ui::SoftShadow(dl, lmin, lmax, 10.0f, 8.0f, theme::Col(c.accent, 0.8f));
        // Rounded rect with a diagonal gradient: fill, then recolour its vertices.
        const int vtx0 = dl->VtxBuffer.Size;
        dl->AddRectFilled(lmin, lmax, IM_COL32_WHITE, 10.0f);
        ImGui::ShadeVertsLinearColorGradientKeepAlpha(dl, vtx0, dl->VtxBuffer.Size, lmin, lmax,
            theme::Col(anim::LerpColor(c.accent, ImVec4(1, 1, 1, 1), 0.28f)), theme::Col(anim::LerpColor(c.accent, ImVec4(0, 0, 0, 1), 0.22f)));
        ui::DrawIcon(dl, ui::Icon::Sparkle, ImVec2((lmin.x + lmax.x) * 0.5f, (lmin.y + lmax.y) * 0.5f), 18.0f, IM_COL32(255, 255, 255, 255));
        if (wide > 0.02f)
        {
            ui::TextAt(dl, f.semibold, 17.0f, ImVec2(lmax.x + 12.0f, p.y + 1.0f), theme::Col(c.text, wide), "Nova");
            ui::TextAt(dl, f.regular, theme::kSmall, ImVec2(lmax.x + 12.0f, p.y + 22.0f), theme::Col(c.textDim, wide), "Control Center");
        }
        ImGui::Dummy(ImVec2(1.0f, 56.0f));
        if (wide > 0.5f)
            ui::SectionLabel("SETTINGS");
        else
            ImGui::Dummy(ImVec2(1.0f, 24.0f));

        // Navigation: items on channel 1, the sliding selection indicator on channel 0 (behind).
        dl->ChannelsSplit(2);
        dl->ChannelsSetCurrent(1);
        ImRect selected;
        for (int i = 0; i < kPageCount; i++)
        {
            if (ui::NavItem(kPages[i].name, kPages[i].icon, g_Page == i, wide))
                g_Page = i;
            if (g_Page == i)
                selected = ImRect(ImGui::GetItemRectMin(), ImGui::GetItemRectMax());
            ImGui::Dummy(ImVec2(1.0f, 2.0f));
        }
        dl->ChannelsSetCurrent(0);
        const float rel = selected.Min.y - origin.y;
        g_Indicator = g_Indicator < 0.0f ? rel : anim::Approach(g_Indicator, rel, 0.20f * ui::MotionScale());
        const ImVec2 imin(selected.Min.x, origin.y + g_Indicator);
        const ImVec2 imax(selected.Max.x, imin.y + selected.GetHeight());
        dl->AddRectFilled(imin, imax, theme::Col(c.accentSoft), 9.0f);
        dl->AddRectFilled(ImVec2(origin.x + 2.0f, imin.y + 10.0f), ImVec2(origin.x + 5.0f, imax.y - 10.0f), theme::Col(c.accent), 2.0f);
        STUDIO_REGION("sidebar.indicator", imin, imax);
        STUDIO_STATE("y", g_Indicator);
        dl->ChannelsMerge();

        // Profile
        const ImVec2 pp(origin.x + 14.0f, origin.y + kWindowSize.y - 70.0f);
        dl->AddLine(ImVec2(origin.x + 14.0f, pp.y - 12.0f), ImVec2(origin.x + g_SidebarW - 14.0f, pp.y - 12.0f), theme::Col(c.divider), 1.0f);
        const ImVec2 av(pp.x + 20.0f, pp.y + 22.0f);
        dl->AddCircleFilled(av, 18.0f, theme::Col(anim::LerpColor(c.accent, ImVec4(0.08f, 0.72f, 0.65f, 1.0f), 0.35f)), 32);
        const ImVec2 its = ui::TextSize(f.semibold, 13.0f, "AM");
        ui::TextAt(dl, f.semibold, 13.0f, ImVec2(av.x - its.x * 0.5f, av.y - its.y * 0.5f), IM_COL32(255, 255, 255, 255), "AM");
        dl->AddCircleFilled(ImVec2(av.x + 13.0f, av.y + 13.0f), 5.5f, theme::Col(c.sidebar), 16);
        dl->AddCircleFilled(ImVec2(av.x + 13.0f, av.y + 13.0f), 3.5f, theme::Col(c.success), 16);
        if (wide > 0.02f)
        {
            ui::TextAt(dl, f.medium, 13.5f, ImVec2(av.x + 28.0f, pp.y + 5.0f), theme::Col(c.text, wide), "Alex Morgan");
            ui::TextAt(dl, f.regular, theme::kSmall, ImVec2(av.x + 28.0f, pp.y + 24.0f), theme::Col(c.textDim, wide), "Pro plan");
        }
        STUDIO_REGION("sidebar.profile", ImVec2(pp.x, pp.y), ImVec2(origin.x + g_SidebarW - 14.0f, pp.y + 44.0f));
        ImGui::EndChild();
    }

    // ------------------------------------------------------------------------
    // Pages
    // ------------------------------------------------------------------------
    void TwoColumns(float* col_w)
    {
        *col_w = (ImGui::GetContentRegionAvail().x - 16.0f) * 0.5f;
    }

    void PageGeneral()
    {
        STUDIO_SCOPE("general");
        static const char* kLanguages[] = { "English", "Deutsch", "Français", "Español", "Português", "Italiano" };
        static const char* kUpdates[] = { "Auto", "Weekly", "Off" };
        float w;
        TwoColumns(&w);
        ImGui::BeginGroup();
        if (ui::BeginCard("general.application", "Application", "How Nova starts and stays up to date", w))
        {
            ui::Combo("Language", &g_Settings.language, kLanguages, IM_ARRAYSIZE(kLanguages));
            ui::Toggle("Launch on startup", &g_Settings.launchOnStartup, "Start Nova when you sign in");
            ui::Toggle("Minimize to tray", &g_Settings.minimizeToTray, "Keep running in the background");
            ui::Segmented("Updates", &g_Settings.updates, kUpdates, IM_ARRAYSIZE(kUpdates));
            ui::EndCard();
        }
        ImGui::EndGroup();
        ImGui::SameLine(0.0f, 16.0f);
        ImGui::BeginGroup();
        if (ui::BeginCard("general.notifications", "Notifications", "Alerts, sounds and focus time", w))
        {
            ui::Toggle("Desktop notifications", &g_Settings.notifications, "Show alerts for downloads and invites");
            ui::Toggle("Notification sounds", &g_Settings.notificationSounds);
            ui::Toggle("Do not disturb", &g_Settings.doNotDisturb, "Silence everything while you play");
            ui::EndCard();
        }
        ImGui::EndGroup();
    }

    void PerformanceCard(float w)
    {
        if (!ui::BeginCard("graphics.performance", "Performance", nullptr, w))
            return;
        float sum = 0.0f;
        float worst = 0.0f;
        const int n = IM_ARRAYSIZE(g_FrameTimes);
        for (int i = 0; i < n; i++)
        {
            sum += g_FrameTimes[i];
            worst = ImMax(worst, g_FrameTimes[i]);
        }
        const float avg = sum / n;
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const ImVec2 p = ImGui::GetCursorScreenPos();
        const float colw = (ImGui::GetContentRegionAvail().x - 28.0f) / 3.0f;
        char v[3][32];
        snprintf(v[0], sizeof(v[0]), "%.0f", 1000.0f / avg);
        snprintf(v[1], sizeof(v[1]), "%.0f", 1000.0f / worst);
        snprintf(v[2], sizeof(v[2]), "%.1f ms", avg);
        const char* k[3] = { "Average FPS", "1% low", "Frame time" };
        for (int i = 0; i < 3; i++)
        {
            const float x = p.x + 14.0f + i * colw;
            ui::TextAt(dl, f.semibold, 22.0f, ImVec2(x, p.y + 2.0f), theme::Col(i == 0 ? c.text : c.text), v[i]);
            ui::TextAt(dl, f.regular, theme::kSmall, ImVec2(x, p.y + 30.0f), theme::Col(c.textDim), k[i]);
        }
        ImGui::Dummy(ImVec2(1.0f, 48.0f));
        ImGui::SetCursorScreenPos(ImVec2(ImGui::GetCursorScreenPos().x + 14.0f, ImGui::GetCursorScreenPos().y));
        ui::Sparkline("Frame time", g_FrameTimes, n, 4.0f, 12.0f, ImVec2(ImGui::GetContentRegionAvail().x - 14.0f, 44.0f));
        ImGui::Dummy(ImVec2(1.0f, 4.0f));
        ui::EndCard();
    }

    void PageGraphics()
    {
        STUDIO_SCOPE("graphics");
        static const char* kResolutions[] = { "1280 x 720", "1600 x 900", "1920 x 1080", "2560 x 1440", "3840 x 2160" };
        static const char* kModes[] = { "Windowed", "Borderless", "Fullscreen" };
        static const char* kPresets[] = { "Low", "Medium", "High", "Ultra" };
        static const char* kAA[] = { "Off", "FXAA", "TAA", "MSAA 4x" };
        float w;
        TwoColumns(&w);
        ImGui::BeginGroup();
        if (ui::BeginCard("graphics.display", "Display", "Resolution and presentation", w))
        {
            ui::Combo("Resolution", &g_Settings.resolution, kResolutions, IM_ARRAYSIZE(kResolutions));
            ui::Segmented("Display mode", &g_Settings.displayMode, kModes, IM_ARRAYSIZE(kModes));
            ui::Toggle("VSync", &g_Settings.vsync, "Sync frames to the display refresh rate");
            ui::Slider("Frame rate limit", &g_Settings.fpsLimit, 30.0f, 240.0f, "%.0f fps");
            ui::EndCard();
        }
        ImGui::Dummy(ImVec2(1.0f, 8.0f));
        PerformanceCard(w);
        ImGui::EndGroup();
        ImGui::SameLine(0.0f, 16.0f);
        ImGui::BeginGroup();
        if (ui::BeginCard("graphics.quality", "Quality", "Balance fidelity and speed", w))
        {
            ui::Segmented("Preset", &g_Settings.preset, kPresets, IM_ARRAYSIZE(kPresets));
            ui::Slider("Render scale", &g_Settings.renderScale, 50.0f, 200.0f, "%.0f%%", "Resolution of the 3D scene");
            ui::Combo("Anti-aliasing", &g_Settings.antiAliasing, kAA, IM_ARRAYSIZE(kAA));
            ui::Toggle("Shadows", &g_Settings.shadows);
            ui::Toggle("Motion blur", &g_Settings.motionBlur);
            ui::Toggle("Bloom", &g_Settings.bloom, "Glow around bright light sources");
            ui::EndCard();
        }
        ImGui::EndGroup();
    }

    void PageAudio()
    {
        STUDIO_SCOPE("audio");
        static const char* kDevices[] = { "System default", "Speakers", "Headphones (USB)", "HDMI output" };
        static const char* kRange[] = { "Night", "Standard", "Wide" };
        float w;
        TwoColumns(&w);
        ImGui::BeginGroup();
        if (ui::BeginCard("audio.mix", "Mix", "Volume per channel", w))
        {
            ui::Combo("Output device", &g_Settings.outputDevice, kDevices, IM_ARRAYSIZE(kDevices));
            ui::Slider("Master", &g_Settings.masterVolume, 0.0f, 100.0f, "%.0f%%");
            ui::Slider("Music", &g_Settings.musicVolume, 0.0f, 100.0f, "%.0f%%");
            ui::Slider("Effects", &g_Settings.effectsVolume, 0.0f, 100.0f, "%.0f%%");
            ui::Slider("Voice chat", &g_Settings.voiceVolume, 0.0f, 100.0f, "%.0f%%");
            ui::EndCard();
        }
        ImGui::EndGroup();
        ImGui::SameLine(0.0f, 16.0f);
        ImGui::BeginGroup();
        if (ui::BeginCard("audio.behaviour", "Behaviour", "How audio reacts to focus and space", w))
        {
            ui::Toggle("Mute when unfocused", &g_Settings.muteUnfocused);
            ui::Toggle("Spatial audio", &g_Settings.spatialAudio, "Positional sound for headphones");
            ui::Segmented("Dynamic range", &g_Settings.dynamicRange, kRange, IM_ARRAYSIZE(kRange));
            ui::EndCard();
        }
        ImGui::EndGroup();
    }

    void PageControls()
    {
        STUDIO_SCOPE("controls");
        float w;
        TwoColumns(&w);
        ImGui::BeginGroup();
        if (ui::BeginCard("controls.movement", "Movement", "Click a key, then press the new one", w))
        {
            ui::Keybind("Move forward", &g_Settings.keyForward);
            ui::Keybind("Move back", &g_Settings.keyBack);
            ui::Keybind("Strafe left", &g_Settings.keyLeft);
            ui::Keybind("Strafe right", &g_Settings.keyRight);
            ui::Keybind("Jump", &g_Settings.keyJump);
            ui::Keybind("Interact", &g_Settings.keyInteract);
            ui::EndCard();
        }
        ImGui::EndGroup();
        ImGui::SameLine(0.0f, 16.0f);
        ImGui::BeginGroup();
        if (ui::BeginCard("controls.mouse", "Mouse", "Pointer feel", w))
        {
            ui::Slider("Sensitivity", &g_Settings.sensitivity, 0.1f, 5.0f, "%.2fx");
            ui::Toggle("Invert Y axis", &g_Settings.invertY);
            ui::Toggle("Raw input", &g_Settings.rawInput, "Bypass OS pointer acceleration");
            ui::EndCard();
        }
        ImGui::EndGroup();
    }

    void PageAppearance()
    {
        STUDIO_SCOPE("appearance");
        float w;
        TwoColumns(&w);
        ImGui::BeginGroup();
        if (ui::BeginCard("appearance.theme", "Theme", "Make Nova yours", w))
        {
            ui::ColorSwatches("Accent colour", &g_Settings.accent, theme::kAccents, theme::kAccentNames, 6);
            ui::Toggle("Compact sidebar", &g_Settings.compactSidebar, "Icons only navigation");
            ui::EndCard();
        }
        ImGui::EndGroup();
        ImGui::SameLine(0.0f, 16.0f);
        ImGui::BeginGroup();
        if (ui::BeginCard("appearance.motion", "Motion", "Transitions and animation", w))
        {
            ui::Toggle("Reduce motion", &g_Settings.reduceMotion, "Disable transitions and animations");
            ui::EndCard();
        }
        ImGui::EndGroup();
    }

    // ------------------------------------------------------------------------
    // Header / footer
    // ------------------------------------------------------------------------
    void Header(const ImVec2& min, float width)
    {
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        const Page& page = kPages[g_Page];
        ui::TextAt(dl, f.semibold, theme::kTitle, ImVec2(min.x + 28.0f, min.y + 20.0f), theme::Col(c.text), page.name);
        ui::TextAt(dl, f.regular, 13.0f, ImVec2(min.x + 28.0f, min.y + 49.0f), theme::Col(c.textDim), page.subtitle);
        STUDIO_REGION("header.title", ImVec2(min.x + 28.0f, min.y + 20.0f), ImVec2(min.x + 28.0f + ui::TextSize(f.semibold, theme::kTitle, page.name).x, min.y + 20.0f + theme::kTitle));

        const float sw = 260.0f;
        ImGui::SetCursorScreenPos(ImVec2(min.x + width - 28.0f - sw, min.y + 24.0f));
        STUDIO_SCOPE("header");
        ui::SearchField("##search", g_Search, IM_ARRAYSIZE(g_Search), sw);
        dl->AddLine(ImVec2(min.x, min.y + kHeaderH - 0.5f), ImVec2(min.x + width, min.y + kHeaderH - 0.5f), theme::Col(c.divider), 1.0f);
    }

    void Footer(const ImVec2& min, float width)
    {
        const theme::Palette& c = theme::Colors();
        const theme::Fonts& f = theme::Font();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        dl->AddLine(ImVec2(min.x, min.y + 0.5f), ImVec2(min.x + width, min.y + 0.5f), theme::Col(c.divider), 1.0f);

        const bool dirty = g_Settings != g_Applied;
        const float d = anim::Approach(anim::Get(ImGui::GetID("##footer"), 0, dirty ? 1.0f : 0.0f), dirty ? 1.0f : 0.0f, 0.2f * ui::MotionScale());
        anim::Set(ImGui::GetID("##footer"), 0, d);
        const ImVec2 dot(min.x + 32.0f, min.y + kFooterH * 0.5f);
        const ImVec4 dotCol = anim::LerpColor(c.success, ImVec4(0.98f, 0.73f, 0.24f, 1.0f), d);
        dl->AddCircleFilled(dot, 7.0f, theme::Col(dotCol, 0.18f), 16);
        dl->AddCircleFilled(dot, 3.5f, theme::Col(dotCol), 16);
        const char* status = dirty ? "Unsaved changes" : "All changes saved";
        ui::TextAt(dl, f.medium, 13.5f, ImVec2(dot.x + 14.0f, dot.y - 8.0f), theme::Col(c.textDim), status);
        if (g_Search[0])
        {
            char buf[96];
            snprintf(buf, sizeof(buf), "%d setting%s hidden by search", ui::FilteredOutCount(), ui::FilteredOutCount() == 1 ? "" : "s");
            const float x = dot.x + 14.0f + ui::TextSize(f.medium, 13.5f, status).x + 18.0f;
            ui::TextAt(dl, f.regular, 13.0f, ImVec2(x, dot.y - 8.0f), theme::Col(c.textFaint), buf);
        }

        STUDIO_SCOPE("footer");
        const float bh = 38.0f;
        ImGui::SetCursorScreenPos(ImVec2(min.x + width - 28.0f - 132.0f - 12.0f - 150.0f, min.y + (kFooterH - bh) * 0.5f));
        if (ui::Button("Reset to defaults", false, ImVec2(150.0f, bh)))
        {
            const int accent = g_Settings.accent;
            g_Settings = Settings();
            g_Settings.accent = accent;
            ui::PushToast("Defaults restored", "Settings were reset. Apply to keep them.");
        }
        ImGui::SameLine(0.0f, 12.0f);
        if (ui::Button("Apply changes", true, ImVec2(132.0f, bh), dirty))
        {
            g_Applied = g_Settings;
            ui::PushToast("Settings saved", "Your changes have been applied.");
        }
    }
}

namespace menu
{
    void Init()
    {
        for (int i = 0; i < IM_ARRAYSIZE(g_FrameTimes); i++)
            g_FrameTimes[i] = FakeFrameTime(g_FrameIndex++);
        g_Applied = g_Settings;
    }

    void Render()
    {
        theme::SetAccent(g_Settings.accent);
        ui::MotionScale() = g_Settings.reduceMotion ? 0.0f : 1.0f;
        UpdateFrameTimes();

        const ImGuiViewport* vp = ImGui::GetMainViewport();
        const ImVec2 pos(IM_TRUNC(vp->Pos.x + (vp->Size.x - kWindowSize.x) * 0.5f), IM_TRUNC(vp->Pos.y + (vp->Size.y - kWindowSize.y) * 0.5f));
        DrawBackdrop(vp, pos, kWindowSize);

        ImGui::SetNextWindowPos(pos);
        ImGui::SetNextWindowSize(kWindowSize);
        ImGui::Begin("Nova", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoBringToFrontOnFocus);
        const theme::Palette& c = theme::Colors();

        Sidebar(pos);

        // Main column
        const ImVec2 mainMin(pos.x + g_SidebarW, pos.y);
        const float mainW = kWindowSize.x - g_SidebarW;
        Header(mainMin, mainW);

        if (g_LastPage != g_Page)
        {
            g_PageFade = g_LastPage < 0 ? 1.0f : 0.0f;
            g_LastPage = g_Page;
        }
        g_PageFade = anim::Step(g_PageFade, 1.0f, 0.22f * ui::MotionScale());
        const float fade = anim::EaseOutCubic(g_PageFade);

        ui::SetFilter(g_Search);
        ImGui::SetCursorScreenPos(ImVec2(mainMin.x, mainMin.y + kHeaderH + (1.0f - fade) * 10.0f));
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(24.0f, 18.0f));
        ImGui::PushStyleVar(ImGuiStyleVar_Alpha, 0.25f + 0.75f * fade);
        ImGui::BeginChild("##page", ImVec2(mainW, kWindowSize.y - kHeaderH - kFooterH), ImGuiChildFlags_AlwaysUseWindowPadding);
        ImGui::PopStyleVar(2);
        STUDIO_REGION("page", ImGui::GetWindowPos(), ImVec2(ImGui::GetWindowPos().x + ImGui::GetWindowSize().x, ImGui::GetWindowPos().y + ImGui::GetWindowSize().y));
        STUDIO_STATE("fade", fade);
        switch (g_Page)
        {
        case 0: PageGeneral(); break;
        case 1: PageGraphics(); break;
        case 2: PageAudio(); break;
        case 3: PageControls(); break;
        default: PageAppearance(); break;
        }
        ImGui::EndChild();

        ImGui::SetCursorScreenPos(ImVec2(mainMin.x, pos.y + kWindowSize.y - kFooterH));
        ImGui::BeginChild("##footer", ImVec2(mainW, kFooterH), ImGuiChildFlags_None, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
        Footer(ImGui::GetWindowPos(), mainW);
        ImGui::EndChild();

        ImGui::GetWindowDrawList()->AddRect(pos, ImVec2(pos.x + kWindowSize.x, pos.y + kWindowSize.y), theme::Col(c.cardBorder), 14.0f, 0, 1.0f);
        ImGui::End();

        ui::RenderToasts(ImVec2(pos.x + kWindowSize.x - 24.0f, pos.y + kWindowSize.y - kFooterH - 16.0f));
    }
}
