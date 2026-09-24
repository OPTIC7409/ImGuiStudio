// imconfig_studio.h - Dear ImGui configuration used for ImGui Studio preview builds only.
// Injected via -DIMGUI_USER_CONFIG. Native/exported builds use the regular imconfig.h.
#pragma once

// Enables the item hooks ImGui Studio uses to observe every widget (bounds, labels, status).
#ifndef IMGUI_ENABLE_TEST_ENGINE
#define IMGUI_ENABLE_TEST_ENGINE
#endif

// Report assertion failures to the Studio (file/line/expression) before aborting,
// so an agent receives a structured runtime error instead of a silent crash.
void StudioAssertFailed(const char* expr, const char* file, int line);
#define IM_ASSERT(_EXPR) do { if (!(_EXPR)) StudioAssertFailed(#_EXPR, __FILE__, __LINE__); } while (0)

// Project-specific additions (optional): add "imconfig": "path/to/file.h" in studio.json.
#ifdef IMGUI_STUDIO_PROJECT_CONFIG
#include IMGUI_STUDIO_PROJECT_CONFIG
#endif
