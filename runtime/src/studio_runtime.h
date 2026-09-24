// studio_runtime.h - internal interface between the ImGui Studio registry and a host.
#pragma once

#include "imgui.h"

namespace StudioRuntime
{
    void        Init();                         // After ImGui::CreateContext()
    void        PreNewFrame();                  // Before ImGui::NewFrame()
    void        PostRender();                   // After ImGui::Render()

    // Snapshot of the last completed frame, as JSON.
    const char* WidgetsJson();
    const char* FrameJson();

    // Queue a value write for an item bound with STUDIO_BIND*; applied the next time the item is submitted.
    void        QueueSetNumbers(ImGuiID id, int count, const double* values);
    void        QueueSetText(ImGuiID id, const char* text);
    bool        ScrollItemIntoView(ImGuiID id);
    const char* FindByLabelJson(const char* label);     // ids of items whose ID == hash(label, id-stack seed)

    // Host callbacks (implemented by the host)
    void        HostLog(int level, const char* msg);            // 0=info 1=warning 2=error
}
