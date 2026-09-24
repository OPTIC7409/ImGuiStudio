// Native host exported by ImGui Studio (GLFW + OpenGL 3).
//
// It drives exactly the same AppInit()/AppFrame() entry points as the Studio's
// WebAssembly preview, so the UI you iterated on in the Studio runs unchanged.
// Already have an application? Skip this file: call AppInit() once after
// creating your Dear ImGui context/backends and AppFrame() every frame.

#include "imgui.h"
#include "imgui_impl_glfw.h"
#include "imgui_impl_opengl3.h"
#include "studio_app.h"

#include <GLFW/glfw3.h>
#include <cstdio>

#ifndef STUDIO_WINDOW_TITLE
#define STUDIO_WINDOW_TITLE "{{TITLE}}"
#endif
#ifndef STUDIO_WINDOW_WIDTH
#define STUDIO_WINDOW_WIDTH {{WIDTH}}
#endif
#ifndef STUDIO_WINDOW_HEIGHT
#define STUDIO_WINDOW_HEIGHT {{HEIGHT}}
#endif

static void GlfwErrorCallback(int error, const char* description)
{
    fprintf(stderr, "GLFW error %d: %s\n", error, description);
}

int main(int, char**)
{
    glfwSetErrorCallback(GlfwErrorCallback);
    if (!glfwInit())
        return 1;

#if defined(__APPLE__)
    const char* glsl_version = "#version 150";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 2);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GL_TRUE);
#else
    const char* glsl_version = "#version 130";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);
#endif

    GLFWwindow* window = glfwCreateWindow(STUDIO_WINDOW_WIDTH, STUDIO_WINDOW_HEIGHT, STUDIO_WINDOW_TITLE, nullptr, nullptr);
    if (window == nullptr)
        return 1;
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr;   // same as the Studio preview; set a path to persist window layout
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glsl_version);

    AppInit();

    const float clear[4] = { {{CLEAR_R}}f, {{CLEAR_G}}f, {{CLEAR_B}}f, 1.0f };
    while (!glfwWindowShouldClose(window))
    {
        glfwPollEvents();
        if (glfwGetWindowAttrib(window, GLFW_ICONIFIED) != 0)
        {
            ImGui_ImplGlfw_Sleep(10);
            continue;
        }

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        AppFrame();

        ImGui::Render();
        int display_w, display_h;
        glfwGetFramebufferSize(window, &display_w, &display_h);
        glViewport(0, 0, display_w, display_h);
        glClearColor(clear[0], clear[1], clear[2], clear[3]);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        glfwSwapBuffers(window);
    }

    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}
