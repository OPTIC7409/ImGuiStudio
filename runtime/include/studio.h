// studio.h - ImGui Studio instrumentation API
//
// This header is safe to ship in native builds. Unless IMGUI_STUDIO is defined,
// every macro below expands to nothing, so instrumented code compiles unchanged
// inside a normal Dear ImGui application.
//
// ImGui Studio automatically sees every Dear ImGui item (buttons, sliders,
// InvisibleButton-based custom widgets, windows, ...) through Dear ImGui's
// test-engine hooks. These macros only *add meaning* to what it already sees:
//
//   STUDIO_SCOPE("graphics");          // semantic namespace for items submitted in this C++ scope
//   STUDIO_ID("graphics.vsync");       // explicit stable id for the last submitted item
//   STUDIO_WIDGET("toggle");           // declare the type of the last item (use inside custom widgets)
//   STUDIO_LABEL("Display mode");      // give a label to an item that has none (custom widgets built on ItemAdd())
//   STUDIO_BIND(v);                    // expose + allow setting the value behind the last item (bool*/int*/float*/double*/ImVec2*/ImVec4*)
//   STUDIO_BIND_N(v, n);               // float[n] (n = 1..4)
//   STUDIO_BIND_COLOR(col, n);         // float[3] or float[4] colour
//   STUDIO_BIND_TEXT(buf, size);       // char buffer
//   STUDIO_STATE("anim", t);           // attach extra state (e.g. animation progress) to the last item
//   STUDIO_REGION("sidebar", min, max) // name a rectangle that is not an item (panels, cards, headers)
//
// Typical custom widget:
//
//   bool Toggle(const char* label, bool* v)
//   {
//       ImGui::InvisibleButton(label, size);
//       STUDIO_WIDGET("toggle");
//       STUDIO_BIND(v);
//       ...
//       STUDIO_STATE("anim", t);
//   }
//
// Call site:
//
//   STUDIO_SCOPE("graphics");
//   Toggle("VSync", &settings.vsync);   // -> addressable as "graphics.vsync"

#pragma once

#include "imgui.h"

#if defined(IMGUI_STUDIO)

namespace Studio
{
    // Scopes
    void        PushScope(const char* name);
    void        PopScope();
    struct ScopeGuard
    {
        explicit ScopeGuard(const char* name) { PushScope(name); }
        ~ScopeGuard() { PopScope(); }
        ScopeGuard(const ScopeGuard&) = delete;
        ScopeGuard& operator=(const ScopeGuard&) = delete;
    };

    // Annotate the last submitted item
    void        SetItemId(const char* id, const char* file, int line);
    void        SetItemType(const char* type, const char* file, int line);
    void        SetItemLabel(const char* label, const char* file, int line);
    void        BindValue(bool* v, const char* file, int line);
    void        BindValue(int* v, const char* file, int line);
    void        BindValue(float* v, const char* file, int line);
    void        BindValue(double* v, const char* file, int line);
    void        BindValue(ImVec2* v, const char* file, int line);
    void        BindValue(ImVec4* v, const char* file, int line);    // treated as an RGBA colour
    void        BindFloats(float* v, int count, bool is_color, const char* file, int line);
    void        BindText(char* buf, int buf_size, const char* file, int line);
    void        SetState(const char* key, bool v);
    void        SetState(const char* key, int v);
    void        SetState(const char* key, unsigned int v);
    void        SetState(const char* key, float v);
    void        SetState(const char* key, double v);
    void        SetState(const char* key, const char* v);
    void        SetState(const char* key, const ImVec2& v);
    void        SetState(const char* key, const ImVec4& v);

    // Named rectangle that is not an item (screen coordinates)
    void        AddRegion(const char* id, const ImVec2& min, const ImVec2& max, const char* file, int line);

    // True when running inside ImGui Studio (always false in native builds, see below)
    inline bool IsActive() { return true; }
}

#define STUDIO__CAT2(a, b)             a##b
#define STUDIO__CAT(a, b)              STUDIO__CAT2(a, b)
#define STUDIO_SCOPE(name)             ::Studio::ScopeGuard STUDIO__CAT(studio_scope_, __LINE__)(name)
#define STUDIO_ID(id)                  ::Studio::SetItemId(id, __FILE__, __LINE__)
#define STUDIO_WIDGET(type)            ::Studio::SetItemType(type, __FILE__, __LINE__)
#define STUDIO_LABEL(label)            ::Studio::SetItemLabel(label, __FILE__, __LINE__)
#define STUDIO_BIND(ptr)               ::Studio::BindValue(ptr, __FILE__, __LINE__)
#define STUDIO_BIND_N(ptr, n)          ::Studio::BindFloats(ptr, n, false, __FILE__, __LINE__)
#define STUDIO_BIND_COLOR(ptr, n)      ::Studio::BindFloats(ptr, n, true, __FILE__, __LINE__)
#define STUDIO_BIND_TEXT(buf, size)    ::Studio::BindText(buf, (int)(size), __FILE__, __LINE__)
#define STUDIO_STATE(key, value)       ::Studio::SetState(key, value)
#define STUDIO_REGION(id, min, max)    ::Studio::AddRegion(id, min, max, __FILE__, __LINE__)

#else // !IMGUI_STUDIO

namespace Studio
{
    inline bool IsActive() { return false; }
}

#define STUDIO_SCOPE(name)             ((void)0)
#define STUDIO_ID(id)                  ((void)0)
#define STUDIO_WIDGET(type)            ((void)0)
#define STUDIO_LABEL(label)            ((void)0)
#define STUDIO_BIND(ptr)               ((void)0)
#define STUDIO_BIND_N(ptr, n)          ((void)0)
#define STUDIO_BIND_COLOR(ptr, n)      ((void)0)
#define STUDIO_BIND_TEXT(buf, size)    ((void)0)
#define STUDIO_STATE(key, value)       ((void)0)
#define STUDIO_REGION(id, min, max)    ((void)0)

#endif // IMGUI_STUDIO
