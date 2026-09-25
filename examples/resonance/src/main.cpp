// Resonance - settings window composition.
#define IMGUI_DEFINE_MATH_OPERATORS
#include "imgui.h"
#include "imgui_internal.h"
#include "studio.h"
#include "studio_app.h"
#include "theme.h"
#include "ui.h"
#include <cstdio>

using namespace theme;

namespace
{
    // ---- Settings model ---------------------------------------------------
    struct Settings
    {
        // General
        bool  reopen_last = true;
        bool  welcome_screen = false;
        int   language = 0;
        int   updates = 1;
        bool  autosave = true;
        float autosave_min = 5.0f;
        float undo_steps = 250.0f;

        // Audio
        int   driver = 0;
        int   output_device = 0;
        int   input_device = 0;
        int   sample_rate = 1;
        int   buffer = 3;
        bool  exclusive = true;
        bool  low_latency_monitor = true;
        float input_gain = 0.0f;
        bool  multicore = true;
        int   dither = 1;
        ImVec4 meter_colour = ImVec4(0.247f, 0.812f, 0.557f, 1.0f);
        bool  clip_hold = true;
        int   meter_mode = 0;
        ImGuiKeyChord engine_key = ImGuiMod_Ctrl | ImGuiKey_E;

        // MIDI
        bool  midi_in[3] = { true, true, false };
        int   clock_source = 0;
        bool  send_clock = false;
        float sync_offset = 0.0f;

        // Appearance
        int   theme_idx = 0;
        ImVec4 accent = ImVec4(0x6C / 255.0f, 0x60 / 255.0f, 1.0f, 1.0f);
        int   scale_idx = 1;
        int   waveform = 0;
        bool  show_grid = true;
        bool  reduce_motion = false;

        // Shortcuts
        ImGuiKeyChord play = ImGuiKey_Space;
        ImGuiKeyChord record = ImGuiKey_R;
        ImGuiKeyChord loop = ImGuiMod_Ctrl | ImGuiKey_L;
        ImGuiKeyChord undo = ImGuiMod_Ctrl | ImGuiKey_Z;
        ImGuiKeyChord redo = ImGuiMod_Ctrl | ImGuiMod_Shift | ImGuiKey_Z;
        ImGuiKeyChord split = ImGuiKey_S;
        ImGuiKeyChord duplicate = ImGuiMod_Ctrl | ImGuiKey_D;
    };

    Settings g_S, g_Saved;
    bool     g_dirty = false;
    int      g_preset = 0;

    enum Page { Page_General, Page_Audio, Page_Midi, Page_Appearance, Page_Shortcuts, Page_COUNT };
    int    g_page = Page_Audio;
    float  g_page_t = 1.0f;       // linear page-transition progress
    ImVec2 g_win_pos(-1, -1);
    float  g_applied_scale = 1.0f;

    const char* const kPresets[]     = { "Studio Default", "Live Performance", "Mixing, Low CPU", "Podcast Recording" };
    const char* const kDrivers[]     = { "ASIO", "WASAPI", "DirectSound" };
    const char* const kOutputs[]     = { "Scarlett 4i4 USB", "RME Babyface Pro", "Realtek Speakers", "System Default" };
    const char* const kInputs[]      = { "Scarlett 4i4 In 1-2", "Babyface Pro In 1-2", "Microphone Array", "None" };
    const char* const kRates[]       = { "44.1", "48", "88.2", "96" };
    const float       kRateHz[]      = { 44100, 48000, 88200, 96000 };
    const int         kBuffers[]     = { 32, 64, 128, 256, 512, 1024, 2048 };
    const char* const kDither[]      = { "Off", "TPDF", "Noise shaped" };
    const char* const kMeterModes[]  = { "Peak", "RMS", "LUFS" };
    const char* const kLanguages[]   = { "English", "Deutsch", "Français", "日本語" };
    const char* const kUpdates[]     = { "Never", "Weekly", "Daily" };
    const char* const kClockSrc[]    = { "Internal", "KeyStep 37", "Launchpad X" };
    const char* const kThemes[]      = { "Midnight", "Graphite", "Slate" };
    const char* const kScales[]      = { "90%", "100%", "110%", "125%" };
    const float       kScaleVals[]   = { 0.9f, 1.0f, 1.1f, 1.25f };
    const char* const kWaveforms[]   = { "Filled", "Outline" };

    struct NavEntry { ui::Icon icon; const char* label; const char* subtitle; };
    const NavEntry kNav[Page_COUNT] = {
        { ui::Icon::General,    "General",    "Startup, projects and updates" },
        { ui::Icon::Audio,      "Audio",      "Devices, latency and monitoring" },
        { ui::Icon::Midi,       "MIDI",       "Controllers and clock sync" },
        { ui::Icon::Appearance, "Appearance", "Theme, accent and scale" },
        { ui::Icon::Shortcuts,  "Shortcuts",  "Transport and editing keys" },
    };

    void ApplyPreset(int p)
    {
        switch (p)
        {
        case 0: g_S.sample_rate = 1; g_S.buffer = 3; g_S.exclusive = true;  g_S.low_latency_monitor = true;  g_S.multicore = true; break;
        case 1: g_S.sample_rate = 1; g_S.buffer = 1; g_S.exclusive = true;  g_S.low_latency_monitor = true;  g_S.multicore = true; break;
        case 2: g_S.sample_rate = 0; g_S.buffer = 5; g_S.exclusive = false; g_S.low_latency_monitor = false; g_S.multicore = true; break;
        case 3: g_S.sample_rate = 1; g_S.buffer = 4; g_S.exclusive = false; g_S.low_latency_monitor = true;  g_S.multicore = false; break;
        }
    }

    // Tracks edits made by any control on the page.
    template <typename T> inline void Track(T changed) { if (changed) g_dirty = true; }

    // Width per column: two columns when both fit their minimum width, else stacked.
    float ColumnWidth(bool* two_col)
    {
        const float avail = ImGui::GetContentRegionAvail().x;
        *two_col = avail >= M().card_min_w * 2.0f + M().gap_lg;
        return *two_col ? (avail - M().gap_lg) * 0.5f : avail;
    }

    void NextColumn(bool two_col)
    {
        ImGui::EndGroup();
        if (two_col)
            ImGui::SameLine(0.0f, M().gap_lg);
        else
            ImGui::Dummy(ImVec2(0.0f, M().gap_lg));
        ImGui::BeginGroup();
    }

    // ---- Pages ------------------------------------------------------------
    void PageGeneral()
    {
        STUDIO_SCOPE("general");
        bool two;
        const float cw = ColumnWidth(&two);
        ImGui::BeginGroup();
        ui::BeginCard("startup", "STARTUP", cw);
        Track(ui::Toggle("Reopen last project", &g_S.reopen_last, "Restore tracks and windows on launch"));
        Track(ui::Toggle("Show welcome screen", &g_S.welcome_screen));
        Track(ui::Combo("Language", &g_S.language, kLanguages, IM_ARRAYSIZE(kLanguages)));
        Track(ui::Combo("Check for updates", &g_S.updates, kUpdates, IM_ARRAYSIZE(kUpdates)));
        const ImVec4 ok = P().success;
        ui::InfoRow("Version", "4.2.0  Up to date", &ok);
        ui::EndCard();
        NextColumn(two);
        ui::BeginCard("projects", "PROJECTS", cw);
        Track(ui::Toggle("Autosave", &g_S.autosave, "Keep a rolling backup while you work"));
        Track(ui::Slider("Autosave interval", &g_S.autosave_min, 1.0f, 30.0f, "%.0f min", 1.0f));
        Track(ui::Slider("Undo history", &g_S.undo_steps, 50.0f, 1000.0f, "%.0f steps", 50.0f));
        ui::PathField("Project folder", "~/Music/Resonance Projects");
        ui::EndCard();
        ImGui::EndGroup();
    }

    void PageAudio()
    {
        STUDIO_SCOPE("audio");
        const float sr = kRateHz[g_S.sample_rate];
        const int   buf = kBuffers[g_S.buffer];
        const float out_ms = buf / sr * 1000.0f + 0.6f;
        const float in_ms = buf / sr * 1000.0f + 0.9f;
        char v_out[16], v_in[16], v_rt[16];
        std::snprintf(v_out, sizeof v_out, "%.1f", out_ms);
        std::snprintf(v_in, sizeof v_in, "%.1f", in_ms);
        std::snprintf(v_rt, sizeof v_rt, "%.1f", out_ms + in_ms);
        const ImVec4 ok = P().success;
        const ui::Stat stats[] = {
            { "OUTPUT LATENCY", v_out, "ms", nullptr },
            { "INPUT LATENCY", v_in, "ms", nullptr },
            { "ROUND TRIP", v_rt, "ms", nullptr },
            { "DEVICE", "Connected", nullptr, &ok },
        };
        ui::StatStrip("latency", stats, IM_ARRAYSIZE(stats));
        ImGui::Dummy(ImVec2(0.0f, M().gap_lg));

        bool two;
        const float cw = ColumnWidth(&two);
        ImGui::BeginGroup();
        ui::BeginCard("output", "OUTPUT", cw);
        Track(ui::Combo("Driver", &g_S.driver, kDrivers, IM_ARRAYSIZE(kDrivers)));
        Track(ui::Combo("Output device", &g_S.output_device, kOutputs, IM_ARRAYSIZE(kOutputs)));
        Track(ui::Segmented("Sample rate", &g_S.sample_rate, kRates, IM_ARRAYSIZE(kRates)));
        char buf_text[32];
        std::snprintf(buf_text, sizeof buf_text, "%d samples", buf);
        Track(ui::SliderSteps("Buffer size", &g_S.buffer, IM_ARRAYSIZE(kBuffers), buf_text));
        Track(ui::Toggle("Exclusive mode", &g_S.exclusive, "Bypass the system mixer for lower latency"));
        ui::EndCard();
        ImGui::Dummy(ImVec2(0.0f, M().gap_lg));
        ui::BeginCard("processing", "PROCESSING", cw);
        Track(ui::Toggle("Multi-core rendering", &g_S.multicore));
        Track(ui::Combo("Dither", &g_S.dither, kDither, IM_ARRAYSIZE(kDither)));
        ui::EndCard();

        NextColumn(two);
        ui::BeginCard("input", "INPUT & MONITORING", cw);
        Track(ui::Combo("Input device", &g_S.input_device, kInputs, IM_ARRAYSIZE(kInputs)));
        Track(ui::Toggle("Low-latency monitoring", &g_S.low_latency_monitor, "Route input directly while recording"));
        Track(ui::Slider("Input gain", &g_S.input_gain, -24.0f, 24.0f, "%+.1f dB", 0.5f));
        ui::EndCard();
        ImGui::Dummy(ImVec2(0.0f, M().gap_lg));
        ui::BeginCard("metering", "METERING & CONTROL", cw);
        Track(ui::Combo("Meter mode", &g_S.meter_mode, kMeterModes, IM_ARRAYSIZE(kMeterModes)));
        Track(ui::ColorField("Meter colour", &g_S.meter_colour));
        Track(ui::Toggle("Hold clip indicators", &g_S.clip_hold));
        Track(ui::Keybind("Toggle audio engine", &g_S.engine_key));
        ui::EndCard();
        ImGui::EndGroup();
    }

    void PageMidi()
    {
        STUDIO_SCOPE("midi");
        bool two;
        const float cw = ColumnWidth(&two);
        ImGui::BeginGroup();
        ui::BeginCard("devices", "INPUT DEVICES", cw, "3 found");
        Track(ui::Toggle("Arturia KeyStep 37", &g_S.midi_in[0], "USB  ·  Channel 1"));
        Track(ui::Toggle("Novation Launchpad X", &g_S.midi_in[1], "USB  ·  All channels"));
        Track(ui::Toggle("IAC Driver Bus 1", &g_S.midi_in[2], "Virtual  ·  All channels"));
        ui::EndCard();
        NextColumn(two);
        ui::BeginCard("sync", "CLOCK & SYNC", cw);
        Track(ui::Combo("Clock source", &g_S.clock_source, kClockSrc, IM_ARRAYSIZE(kClockSrc)));
        Track(ui::Toggle("Send MIDI clock", &g_S.send_clock));
        Track(ui::Slider("Sync offset", &g_S.sync_offset, -50.0f, 50.0f, "%+.0f ms", 1.0f));
        ui::EndCard();
        ImGui::EndGroup();
    }

    void PageAppearance()
    {
        STUDIO_SCOPE("appearance");
        bool two;
        const float cw = ColumnWidth(&two);
        ImGui::BeginGroup();
        ui::BeginCard("theme", "THEME", cw);
        Track(ui::Combo("Theme", &g_S.theme_idx, kThemes, IM_ARRAYSIZE(kThemes)));
        if (ui::ColorField("Accent colour", &g_S.accent))
        {
            SetAccent(g_S.accent);
            g_dirty = true;
        }
        Track(ui::Segmented("Interface scale", &g_S.scale_idx, kScales, IM_ARRAYSIZE(kScales)));
        ui::EndCard();
        NextColumn(two);
        ui::BeginCard("editor", "EDITOR", cw);
        Track(ui::Segmented("Waveform style", &g_S.waveform, kWaveforms, IM_ARRAYSIZE(kWaveforms)));
        Track(ui::Toggle("Show grid", &g_S.show_grid));
        Track(ui::Toggle("Reduce motion", &g_S.reduce_motion, "Shorten interface animations"));
        ui::EndCard();
        ImGui::EndGroup();
    }

    void PageShortcuts()
    {
        STUDIO_SCOPE("shortcuts");
        bool two;
        const float cw = ColumnWidth(&two);
        ImGui::BeginGroup();
        ui::BeginCard("transport", "TRANSPORT", cw);
        Track(ui::Keybind("Play / Stop", &g_S.play));
        Track(ui::Keybind("Record", &g_S.record));
        Track(ui::Keybind("Loop", &g_S.loop));
        Track(ui::Keybind("Toggle audio engine", &g_S.engine_key));
        ui::EndCard();
        NextColumn(two);
        ui::BeginCard("editing", "EDITING", cw);
        Track(ui::Keybind("Undo", &g_S.undo));
        Track(ui::Keybind("Redo", &g_S.redo));
        Track(ui::Keybind("Split at cursor", &g_S.split));
        Track(ui::Keybind("Duplicate", &g_S.duplicate));
        ui::EndCard();
        ImGui::EndGroup();
    }

    // ---- Shell ------------------------------------------------------------
    void Sidebar(ImDrawList* dl, ImVec2 o, float h)
    {
        STUDIO_SCOPE("nav");
        const Metrics& m = M();
        const float s = m.scale;

        // Brand block doubles as a drag handle.
        ImGui::SetCursorScreenPos(o);
        ImGui::InvisibleButton("##drag_brand", ImVec2(m.sidebar_w, m.header_h));
        if (ImGui::IsItemActive() && ImGui::IsMouseDragging(ImGuiMouseButton_Left, 0.0f))
            g_win_pos += ImGui::GetIO().MouseDelta;

        const ImVec2 tile(o.x + m.gap_lg + 2.0f * s, o.y + (m.header_h - 28.0f * s) * 0.5f);
        dl->AddRectFilled(tile, tile + ImVec2(28, 28) * s, Col(P().accent), 7.0f * s);
        ui::DrawIcon(dl, ui::Icon::Logo, tile + ImVec2(14, 14) * s, m.icon, Col(P().on_accent), 1.75f * s);
        ui::Text(dl, T().semibold, T().title, ImVec2(tile.x + 38.0f * s, tile.y - 1.0f * s), Col(P().text_primary), "Resonance");
        ui::Text(dl, T().regular, T().small, ImVec2(tile.x + 38.0f * s, tile.y + 16.0f * s), Col(P().text_muted), "Preferences");

        // Navigation with a sliding active marker.
        const float pad = m.gap_md;
        const float y0 = o.y + m.header_h + 30.0f * s;
        const float step = m.nav_h + 2.0f * s;
        ui::SectionCaption(dl, ImVec2(o.x + pad + 8.0f * s, o.y + m.header_h + 10.0f * s), "SETTINGS");
        const float hy = ui::Animate(ImGui::GetID("##nav_marker"), y0 + g_page * step, 0.20f);
        const ImVec2 ha(o.x + pad, hy), hb(o.x + m.sidebar_w - pad, hy + m.nav_h);
        dl->AddRectFilled(ha, hb, Col(P().accent, 0.13f), m.radius_md);
        dl->AddRectFilled(ImVec2(ha.x, ha.y + 9.0f * s), ImVec2(ha.x + 2.0f * s, hb.y - 9.0f * s), Col(P().accent_hover), 1.0f * s);

        ImGui::PushClipRect(ImVec2(o.x, o.y), ImVec2(o.x + m.sidebar_w, o.y + h), true);
        ImGui::SetCursorScreenPos(ImVec2(o.x + pad, y0));
        ImGui::PushItemWidth(m.sidebar_w - pad * 2);
        ImGui::BeginGroup();
        for (int i = 0; i < Page_COUNT; i++)
        {
            ImGui::SetCursorScreenPos(ImVec2(o.x + pad, y0 + i * step));
            if (ui::NavItem(kNav[i].icon, kNav[i].label, g_page == i) && g_page != i)
            {
                g_page = i;
                g_page_t = 0.0f;
            }
        }
        ImGui::EndGroup();
        ImGui::PopItemWidth();
        ImGui::PopClipRect();

        // Engine status footer.
        const float fy = o.y + h - 56.0f * s;
        dl->AddLine(ImVec2(o.x + pad, fy), ImVec2(o.x + m.sidebar_w - pad, fy), Col(P().divider));
        const float dx = o.x + m.gap_lg + 6.0f * s, dy = fy + 28.0f * s;
        dl->AddCircleFilled(ImVec2(dx, dy), 7.0f * s, Col(P().success, 0.12f), 16);
        dl->AddCircleFilled(ImVec2(dx, dy), 3.5f * s, Col(P().success), 12);
        char meta[48];
        std::snprintf(meta, sizeof meta, "%s kHz  ·  %d smp", kRates[g_S.sample_rate], kBuffers[g_S.buffer]);
        ui::Text(dl, T().medium, T().value, ImVec2(dx + 14.0f * s, dy - 15.0f * s), Col(P().text_secondary), "Engine running");
        ui::Text(dl, T().regular, T().small, ImVec2(dx + 14.0f * s, dy + 2.0f * s), Col(P().text_dim), meta);
    }

    void TopBar(ImDrawList* dl, ImVec2 o, float w)
    {
        STUDIO_SCOPE("topbar");
        const Metrics& m = M();
        const float s = m.scale;
        const float cy = o.y + m.header_h * 0.5f;

        // Right cluster: preset selector, revert, save.
        const float preset_w = 212.0f * s;
        const float save_w = ui::Measure(T().medium, T().value, "Save").x + 28.0f * s;
        const float revert_w = ui::Measure(T().medium, T().value, "Revert").x + 28.0f * s;
        const float right = o.x + w - m.content_pad;
        const float x_save = right - save_w;
        const float x_revert = x_save - m.gap_sm - revert_w;
        const float x_preset = x_revert - m.gap_md - preset_w;
        const float by = cy - m.control_h * 0.5f;

        ImGui::SetCursorScreenPos(o);
        ImGui::InvisibleButton("##drag_top", ImVec2(x_preset - o.x - m.gap_md, m.header_h));
        if (ImGui::IsItemActive() && ImGui::IsMouseDragging(ImGuiMouseButton_Left, 0.0f))
            g_win_pos += ImGui::GetIO().MouseDelta;

        const NavEntry& e = kNav[g_page];
        const float tx = o.x + m.content_pad;
        ui::Text(dl, T().semibold, T().title, ImVec2(tx, cy - 17.0f * s), Col(P().text_primary), e.label);
        ui::Text(dl, T().regular, T().small, ImVec2(tx, cy + 3.0f * s), Col(P().text_muted), e.subtitle);

        ImGui::SetCursorScreenPos(ImVec2(x_preset, by));
        if (ui::ComboBox("Preset", &g_preset, kPresets, IM_ARRAYSIZE(kPresets), preset_w, "Preset"))
        {
            ApplyPreset(g_preset);
            g_dirty = true;
        }
        // Unsaved-changes hint, fades in left of the preset selector.
        const float dirty_t = ui::Animate(ImGui::GetID("##dirty"), g_dirty ? 1.0f : 0.0f, 0.16f);
        if (dirty_t > 0.001f)
        {
            // Full text when there is room, otherwise just the dot.
            const char* msg = "Unsaved changes";
            const float mw = ui::Measure(T().regular, T().small, msg).x;
            const float title_r = tx + ImMax(ui::Measure(T().semibold, T().title, e.label).x, ui::Measure(T().regular, T().small, e.subtitle).x);
            const bool fits = x_preset - m.gap_lg - mw - 10.0f * s - m.gap_lg > title_r;
            const float mx = fits ? x_preset - m.gap_lg - mw : x_preset - m.gap_sm;
            dl->AddCircleFilled(ImVec2(mx - 10.0f * s, cy), 3.0f * s, Col(P().warning, dirty_t), 12);
            if (fits)
                ui::TextV(dl, T().regular, T().small, mx, cy - 8.0f * s, cy + 8.0f * s, Col(P().text_muted, dirty_t), msg);
        }
        ImGui::SetCursorScreenPos(ImVec2(x_revert, by));
        if (ui::Button("Revert", ui::ButtonKind::Secondary, 0.0f, g_dirty))
        {
            g_S = g_Saved;
            SetAccent(g_S.accent);
            g_dirty = false;
        }
        ImGui::SetCursorScreenPos(ImVec2(x_save, by));
        if (ui::Button("Save", ui::ButtonKind::Primary, 0.0f, g_dirty))
        {
            g_Saved = g_S;
            g_dirty = false;
        }
        dl->AddLine(ImVec2(o.x, o.y + m.header_h - 0.5f), ImVec2(o.x + w, o.y + m.header_h - 0.5f), Col(P().border_subtle));
    }
}

void AppInit()
{
    theme::Init();
    g_Saved = g_S;
}

void AppFrame()
{
    // Scale changes apply between frames so a frame never mixes two metric sets.
    const float want_scale = kScaleVals[g_S.scale_idx];
    if (want_scale != g_applied_scale)
    {
        SetScale(want_scale);
        g_applied_scale = want_scale;
    }

    const Metrics& m = M();
    const float s = m.scale;
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    const ImVec2 size(ImMin(920.0f * s, vp->WorkSize.x - 24.0f), ImMin(580.0f * s, vp->WorkSize.y - 24.0f));
    if (g_win_pos.x < 0.0f)
        g_win_pos = vp->WorkPos + (vp->WorkSize - ImVec2(920, 580)) * 0.5f;
    // Keep the whole window on screen (also after a scale change grows it).
    g_win_pos.x = ImClamp(g_win_pos.x, vp->WorkPos.x + 12.0f, vp->WorkPos.x + vp->WorkSize.x - 12.0f - size.x);
    g_win_pos.y = ImClamp(g_win_pos.y, vp->WorkPos.y + 12.0f, vp->WorkPos.y + vp->WorkSize.y - 12.0f - size.y);

    ImGui::SetNextWindowPos(g_win_pos);
    ImGui::SetNextWindowSize(size);
    ImGui::Begin("Resonance Settings", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoScrollbar |
                 ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoBackground);
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const ImVec2 o = ImGui::GetWindowPos();
    const ImVec2 e = o + size;

    // Shell: soft tonal elevation, sidebar and workspace surfaces.
    ImDrawList* bg = ImGui::GetBackgroundDrawList();
    for (int i = 1; i <= 4; i++)
    {
        const float spread = 3.0f * i * s, drop = 2.0f * i * s;
        bg->AddRectFilled(ImVec2(o.x - spread, o.y - spread + drop), ImVec2(e.x + spread, e.y + spread + drop),
                          IM_COL32(0, 0, 0, 24), m.radius_xl + spread);
    }
    dl->AddRectFilled(o, e, Col(P().bg_root), m.radius_xl);
    dl->AddRectFilled(o, ImVec2(o.x + m.sidebar_w, e.y), Col(P().bg_sidebar), m.radius_xl, ImDrawFlags_RoundCornersLeft);
    dl->AddLine(ImVec2(o.x + m.sidebar_w - 0.5f, o.y), ImVec2(o.x + m.sidebar_w - 0.5f, e.y), Col(P().border_subtle));
    dl->AddRect(o + ImVec2(0.5f, 0.5f), e - ImVec2(0.5f, 0.5f), Col(Hex(0x1E2029)), m.radius_xl);
    STUDIO_REGION("shell", o, e);
    STUDIO_REGION("sidebar", o, ImVec2(o.x + m.sidebar_w, e.y));

    Sidebar(dl, o, size.y);
    const ImVec2 wo(o.x + m.sidebar_w, o.y);
    TopBar(dl, wo, size.x - m.sidebar_w);

    // Workspace: page content with a short fade + rise on page change.
    g_page_t = ImMin(1.0f, g_page_t + ImGui::GetIO().DeltaTime / 0.20f);
    const float pe = ui::EaseOutCubic(g_page_t);
    ImGui::SetCursorScreenPos(ImVec2(wo.x, wo.y + m.header_h));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(m.content_pad, m.content_pad));
    ImGui::BeginChild("##workspace", ImVec2(size.x - m.sidebar_w - 1.0f, size.y - m.header_h - 1.0f * s), ImGuiChildFlags_AlwaysUseWindowPadding);
    ImGui::PopStyleVar();
    STUDIO_REGION("workspace", ImGui::GetWindowPos(), ImGui::GetWindowPos() + ImGui::GetWindowSize());
    STUDIO_STATE("page_anim", pe);
    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, pe);
    ImGui::SetCursorPosY(ImGui::GetCursorPosY() + (1.0f - pe) * 8.0f * s);
    switch (g_page)
    {
    case Page_General:    PageGeneral(); break;
    case Page_Audio:      PageAudio(); break;
    case Page_Midi:       PageMidi(); break;
    case Page_Appearance: PageAppearance(); break;
    case Page_Shortcuts:  PageShortcuts(); break;
    }
    ImGui::PopStyleVar();
    ImGui::Dummy(ImVec2(0.0f, 0.0f));
    ImGui::EndChild();

    ImGui::End();
}
