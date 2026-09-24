// studio_host_web.cpp - ImGui Studio's WebAssembly/WebGL2 host.
//
// Owns the Dear ImGui context and the OpenGL3 (WebGL2) renderer, and exposes a
// small C API that the preview page drives from JavaScript:
//   - frames are stepped explicitly (studio_frame) so time can be deterministic,
//   - input is injected through the same functions for humans and agents,
//   - pixels are read back right after rendering for captures.
//
// Your UI code never sees any of this: it only implements AppInit()/AppFrame().

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES3/gl3.h>

#include <cfloat>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "imgui.h"
#include "imgui_internal.h"
#include "backends/imgui_impl_opengl3.h"
#include "studio_app.h"
#include "studio_runtime.h"

namespace
{
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_Gl = 0;
    bool        g_Ready = false;
    int         g_Width = 1280;
    int         g_Height = 800;
    float       g_Scale = 1.0f;
    float       g_Clear[4] = { 0.06f, 0.06f, 0.07f, 1.0f };
    std::string g_Clipboard;

    int FbWidth() { return (int)(g_Width * g_Scale + 0.5f); }
    int FbHeight() { return (int)(g_Height * g_Scale + 0.5f); }

    const char* GetClipboard(ImGuiContext*) { return g_Clipboard.c_str(); }
    void SetClipboard(ImGuiContext*, const char* text) { g_Clipboard = text ? text : ""; }

    struct KeyMap { const char* code; ImGuiKey key; };
    const KeyMap kKeys[] =
    {
        { "Tab", ImGuiKey_Tab }, { "ArrowLeft", ImGuiKey_LeftArrow }, { "ArrowRight", ImGuiKey_RightArrow },
        { "ArrowUp", ImGuiKey_UpArrow }, { "ArrowDown", ImGuiKey_DownArrow }, { "PageUp", ImGuiKey_PageUp },
        { "PageDown", ImGuiKey_PageDown }, { "Home", ImGuiKey_Home }, { "End", ImGuiKey_End },
        { "Insert", ImGuiKey_Insert }, { "Delete", ImGuiKey_Delete }, { "Backspace", ImGuiKey_Backspace },
        { "Space", ImGuiKey_Space }, { "Enter", ImGuiKey_Enter }, { "Escape", ImGuiKey_Escape },
        { "NumpadEnter", ImGuiKey_KeypadEnter },
        { "ControlLeft", ImGuiKey_LeftCtrl }, { "ShiftLeft", ImGuiKey_LeftShift }, { "AltLeft", ImGuiKey_LeftAlt },
        { "MetaLeft", ImGuiKey_LeftSuper }, { "ControlRight", ImGuiKey_RightCtrl }, { "ShiftRight", ImGuiKey_RightShift },
        { "AltRight", ImGuiKey_RightAlt }, { "MetaRight", ImGuiKey_RightSuper }, { "ContextMenu", ImGuiKey_Menu },
        { "Quote", ImGuiKey_Apostrophe }, { "Comma", ImGuiKey_Comma }, { "Minus", ImGuiKey_Minus },
        { "Period", ImGuiKey_Period }, { "Slash", ImGuiKey_Slash }, { "Semicolon", ImGuiKey_Semicolon },
        { "Equal", ImGuiKey_Equal }, { "BracketLeft", ImGuiKey_LeftBracket }, { "Backslash", ImGuiKey_Backslash },
        { "BracketRight", ImGuiKey_RightBracket }, { "Backquote", ImGuiKey_GraveAccent }, { "CapsLock", ImGuiKey_CapsLock },
        { "ScrollLock", ImGuiKey_ScrollLock }, { "NumLock", ImGuiKey_NumLock }, { "PrintScreen", ImGuiKey_PrintScreen },
        { "Pause", ImGuiKey_Pause },
        { "Numpad0", ImGuiKey_Keypad0 }, { "Numpad1", ImGuiKey_Keypad1 }, { "Numpad2", ImGuiKey_Keypad2 },
        { "Numpad3", ImGuiKey_Keypad3 }, { "Numpad4", ImGuiKey_Keypad4 }, { "Numpad5", ImGuiKey_Keypad5 },
        { "Numpad6", ImGuiKey_Keypad6 }, { "Numpad7", ImGuiKey_Keypad7 }, { "Numpad8", ImGuiKey_Keypad8 },
        { "Numpad9", ImGuiKey_Keypad9 }, { "NumpadDecimal", ImGuiKey_KeypadDecimal }, { "NumpadDivide", ImGuiKey_KeypadDivide },
        { "NumpadMultiply", ImGuiKey_KeypadMultiply }, { "NumpadSubtract", ImGuiKey_KeypadSubtract },
        { "NumpadAdd", ImGuiKey_KeypadAdd }, { "NumpadEqual", ImGuiKey_KeypadEqual },
    };

    ImGuiKey CodeToKey(const char* code)
    {
        if (!code || !*code)
            return ImGuiKey_None;
        // KeyA..KeyZ, Digit0..Digit9, F1..F24
        if (strncmp(code, "Key", 3) == 0 && code[3] >= 'A' && code[3] <= 'Z' && code[4] == 0)
            return (ImGuiKey)(ImGuiKey_A + (code[3] - 'A'));
        if (strncmp(code, "Digit", 5) == 0 && code[5] >= '0' && code[5] <= '9' && code[6] == 0)
            return (ImGuiKey)(ImGuiKey_0 + (code[5] - '0'));
        if (code[0] == 'F' && code[1] >= '1' && code[1] <= '9')
        {
            int n = atoi(code + 1);
            if (n >= 1 && n <= 24)
                return (ImGuiKey)(ImGuiKey_F1 + (n - 1));
        }
        for (const KeyMap& k : kKeys)
            if (strcmp(k.code, code) == 0)
                return k.key;
        return ImGuiKey_None;
    }

    void UpdateTexturesOnly()
    {
        // Keep the font atlas texture in sync on frames that are simulated but not drawn.
        for (ImTextureData* tex : ImGui::GetPlatformIO().Textures)
            if (tex->Status != ImTextureStatus_OK)
                ImGui_ImplOpenGL3_UpdateTexture(tex);
    }

    void Present()
    {
        emscripten_webgl_make_context_current(g_Gl);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glViewport(0, 0, FbWidth(), FbHeight());
        glClearColor(g_Clear[0], g_Clear[1], g_Clear[2], g_Clear[3]);
        glClear(GL_COLOR_BUFFER_BIT);
        if (ImDrawData* dd = ImGui::GetDrawData())
            ImGui_ImplOpenGL3_RenderDrawData(dd);
    }
}

void StudioRuntime::HostLog(int level, const char* msg)
{
    EM_ASM({ if (Module.studioOnLog) Module.studioOnLog($0, UTF8ToString($1)); }, level, msg);
}

void StudioAssertFailed(const char* expr, const char* file, int line)
{
    EM_ASM({ if (Module.studioOnAssert) Module.studioOnAssert(UTF8ToString($0), UTF8ToString($1), $2); }, expr, file, line);
    abort();
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE void studio_set_viewport(int w, int h, float scale)
    {
        g_Width = w > 0 ? w : 1;
        g_Height = h > 0 ? h : 1;
        g_Scale = scale > 0.0f ? scale : 1.0f;
        emscripten_set_canvas_element_size("#canvas", FbWidth(), FbHeight());
    }

    EMSCRIPTEN_KEEPALIVE void studio_set_clear_color(float r, float g, float b, float a)
    {
        g_Clear[0] = r; g_Clear[1] = g; g_Clear[2] = b; g_Clear[3] = a;
    }

    // Advance the UI by one frame of `dt` seconds. When render == 0 the frame is
    // simulated (layout, animation, input) but not drawn: this is how deterministic
    // captures fast-forward time cheaply.
    EMSCRIPTEN_KEEPALIVE int studio_frame(double dt, int render)
    {
        if (!g_Ready)
            return 0;
        ImGuiIO& io = ImGui::GetIO();
        io.DisplaySize = ImVec2((float)g_Width, (float)g_Height);
        io.DisplayFramebufferScale = ImVec2(g_Scale, g_Scale);
        io.DeltaTime = dt > 0.0 ? (float)dt : 1.0f / 60.0f;

        ImGui_ImplOpenGL3_NewFrame();
        StudioRuntime::PreNewFrame();
        ImGui::NewFrame();
        AppFrame();
        ImGui::Render();
        StudioRuntime::PostRender();

        if (render)
            Present();
        else
            UpdateTexturesOnly();
        return 1;
    }

    // Re-draw the last frame without advancing time (used right before reading pixels).
    EMSCRIPTEN_KEEPALIVE void studio_present()
    {
        if (g_Ready)
            Present();
    }

    // Read back a region of the framebuffer (top-left origin, framebuffer pixels) as RGBA8.
    // Must be called in the same task as the preceding studio_present()/studio_frame(..., 1).
    EMSCRIPTEN_KEEPALIVE unsigned char* studio_read_pixels(int x, int y, int w, int h)
    {
        if (w <= 0 || h <= 0)
            return nullptr;
        const int fbh = FbHeight();
        const size_t row = (size_t)w * 4;
        unsigned char* tmp = (unsigned char*)malloc(row * h);
        unsigned char* out = (unsigned char*)malloc(row * h);
        if (!tmp || !out)
        {
            free(tmp);
            free(out);
            return nullptr;
        }
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(x, fbh - y - h, w, h, GL_RGBA, GL_UNSIGNED_BYTE, tmp);
        for (int j = 0; j < h; j++)
            memcpy(out + row * j, tmp + row * (h - 1 - j), row);
        free(tmp);
        return out;
    }

    EMSCRIPTEN_KEEPALIVE void studio_free(void* p) { free(p); }

    EMSCRIPTEN_KEEPALIVE void studio_mouse_pos(float x, float y)
    {
        if (!g_Ready) return;
        ImGuiIO& io = ImGui::GetIO();
        io.AddMouseSourceEvent(ImGuiMouseSource_Mouse);
        io.AddMousePosEvent(x, y);
    }

    EMSCRIPTEN_KEEPALIVE void studio_mouse_leave()
    {
        if (!g_Ready) return;
        ImGui::GetIO().AddMousePosEvent(-FLT_MAX, -FLT_MAX);
    }

    EMSCRIPTEN_KEEPALIVE void studio_mouse_button(int button, int down)
    {
        if (!g_Ready || button < 0 || button >= ImGuiMouseButton_COUNT) return;
        ImGui::GetIO().AddMouseButtonEvent(button, down != 0);
    }

    EMSCRIPTEN_KEEPALIVE void studio_mouse_wheel(float dx, float dy)
    {
        if (!g_Ready) return;
        ImGui::GetIO().AddMouseWheelEvent(dx, dy);
    }

    EMSCRIPTEN_KEEPALIVE int studio_key(const char* code, int down)
    {
        if (!g_Ready) return 0;
        ImGuiKey key = CodeToKey(code);
        if (key == ImGuiKey_None)
            return 0;
        ImGui::GetIO().AddKeyEvent(key, down != 0);
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE void studio_mods(int ctrl, int shift, int alt, int super)
    {
        if (!g_Ready) return;
        ImGuiIO& io = ImGui::GetIO();
        io.AddKeyEvent(ImGuiMod_Ctrl, ctrl != 0);
        io.AddKeyEvent(ImGuiMod_Shift, shift != 0);
        io.AddKeyEvent(ImGuiMod_Alt, alt != 0);
        io.AddKeyEvent(ImGuiMod_Super, super != 0);
    }

    EMSCRIPTEN_KEEPALIVE void studio_chars(const char* utf8)
    {
        if (!g_Ready || !utf8) return;
        ImGui::GetIO().AddInputCharactersUTF8(utf8);
    }

    EMSCRIPTEN_KEEPALIVE void studio_focus(int focused)
    {
        if (!g_Ready) return;
        ImGui::GetIO().AddFocusEvent(focused != 0);
    }

    EMSCRIPTEN_KEEPALIVE const char* studio_widgets_json() { return g_Ready ? StudioRuntime::WidgetsJson() : "{}"; }
    EMSCRIPTEN_KEEPALIVE const char* studio_frame_json() { return g_Ready ? StudioRuntime::FrameJson() : "{}"; }

    EMSCRIPTEN_KEEPALIVE void studio_set_value_numbers(unsigned int id, int count, double a, double b, double c, double d)
    {
        const double v[4] = { a, b, c, d };
        StudioRuntime::QueueSetNumbers((ImGuiID)id, count, v);
    }

    EMSCRIPTEN_KEEPALIVE void studio_set_value_text(unsigned int id, const char* text)
    {
        StudioRuntime::QueueSetText((ImGuiID)id, text);
    }

    EMSCRIPTEN_KEEPALIVE int studio_scroll_into_view(unsigned int id)
    {
        return g_Ready && StudioRuntime::ScrollItemIntoView((ImGuiID)id) ? 1 : 0;
    }

    EMSCRIPTEN_KEEPALIVE const char* studio_find_by_label(const char* label) { return g_Ready ? StudioRuntime::FindByLabelJson(label) : "[]"; }

    EMSCRIPTEN_KEEPALIVE int studio_get_cursor() { return g_Ready ? (int)ImGui::GetMouseCursor() : 0; }
    EMSCRIPTEN_KEEPALIVE int studio_is_ready() { return g_Ready ? 1 : 0; }
}

int main()
{
    g_Width = EM_ASM_INT({ return (Module.studioConfig && Module.studioConfig.width) | 0 || 1280; });
    g_Height = EM_ASM_INT({ return (Module.studioConfig && Module.studioConfig.height) | 0 || 800; });
    g_Scale = (float)EM_ASM_DOUBLE({ return (Module.studioConfig && Module.studioConfig.scale) || 1.0; });

    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = false;
    attrs.depth = false;
    attrs.stencil = false;
    attrs.antialias = false;
    attrs.premultipliedAlpha = false;
    attrs.preserveDrawingBuffer = true;
    g_Gl = emscripten_webgl_create_context("#canvas", &attrs);
    if (g_Gl <= 0)
    {
        EM_ASM({ if (Module.studioOnFatal) Module.studioOnFatal("WebGL2 is not available in this browser (emscripten_webgl_create_context failed)"); });
        return 1;
    }
    emscripten_webgl_make_context_current(g_Gl);
    studio_set_viewport(g_Width, g_Height, g_Scale);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr;       // deterministic: no persisted window positions between runs
    io.LogFilename = nullptr;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.BackendPlatformName = "imgui_studio_web";
    io.DisplaySize = ImVec2((float)g_Width, (float)g_Height);
    ImGuiPlatformIO& pio = ImGui::GetPlatformIO();
    pio.Platform_GetClipboardTextFn = GetClipboard;
    pio.Platform_SetClipboardTextFn = SetClipboard;

    StudioRuntime::Init();
    ImGui_ImplOpenGL3_Init("#version 300 es");

    AppInit();

    g_Ready = true;
    EM_ASM({ if (Module.studioOnReady) Module.studioOnReady(); });
    return 0;
}
