// settings.hpp - the state edited by the menu.
#pragma once

#include "imgui.h"

struct Settings
{
    // General
    int   language = 0;
    bool  launchOnStartup = true;
    bool  minimizeToTray = false;
    int   updates = 0;
    bool  notifications = true;
    bool  notificationSounds = true;
    bool  doNotDisturb = false;

    // Graphics
    int   resolution = 2;
    int   displayMode = 1;
    bool  vsync = true;
    float fpsLimit = 144.0f;
    int   preset = 2;
    float renderScale = 100.0f;
    int   antiAliasing = 2;
    bool  shadows = true;
    bool  motionBlur = false;
    bool  bloom = true;

    // Audio
    int   outputDevice = 0;
    float masterVolume = 80.0f;
    float musicVolume = 55.0f;
    float effectsVolume = 70.0f;
    float voiceVolume = 90.0f;
    bool  muteUnfocused = true;
    bool  spatialAudio = true;
    int   dynamicRange = 1;

    // Controls
    ImGuiKey keyForward = ImGuiKey_W;
    ImGuiKey keyBack = ImGuiKey_S;
    ImGuiKey keyLeft = ImGuiKey_A;
    ImGuiKey keyRight = ImGuiKey_D;
    ImGuiKey keyJump = ImGuiKey_Space;
    ImGuiKey keyInteract = ImGuiKey_E;
    float sensitivity = 1.25f;
    bool  invertY = false;
    bool  rawInput = true;

    // Appearance
    int   accent = 0;
    bool  reduceMotion = false;
    bool  compactSidebar = false;

    bool operator==(const Settings& o) const;
    bool operator!=(const Settings& o) const { return !(*this == o); }
};
