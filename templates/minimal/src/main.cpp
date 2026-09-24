// The two entry points every ImGui Studio project implements (see studio_app.h).
#include "imgui.h"
#include "studio.h"
#include "studio_app.h"

namespace
{
    struct Settings
    {
        bool  vsync = true;
        float fov = 90.0f;
        int   quality = 1;
    } g_Settings;
}

void AppInit()
{
    ImGui::StyleColorsDark();
    ImGuiStyle& style = ImGui::GetStyle();
    style.WindowRounding = 8.0f;
    style.FrameRounding = 4.0f;
}

void AppFrame()
{
    ImGui::SetNextWindowPos(ImVec2(40, 40), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSize(ImVec2(360, 220), ImGuiCond_FirstUseEver);
    ImGui::Begin("Settings");

    STUDIO_SCOPE("graphics");
    ImGui::Checkbox("VSync", &g_Settings.vsync);
    STUDIO_BIND(&g_Settings.vsync);

    ImGui::SliderFloat("FOV", &g_Settings.fov, 30.0f, 180.0f, "%.0f");
    STUDIO_BIND(&g_Settings.fov);

    const char* qualities[] = { "Low", "Medium", "High" };
    ImGui::Combo("Quality", &g_Settings.quality, qualities, IM_ARRAYSIZE(qualities));
    STUDIO_BIND(&g_Settings.quality);

    if (ImGui::Button("Apply"))
        ImGui::OpenPopup("Applied");
    if (ImGui::BeginPopup("Applied"))
    {
        ImGui::TextUnformatted("Settings applied.");
        ImGui::EndPopup();
    }
    ImGui::End();
}
