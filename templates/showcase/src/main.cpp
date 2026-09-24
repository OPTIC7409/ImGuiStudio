// main.cpp - entry points called by the host (ImGui Studio's WebGL2 preview,
// or native/main.cpp in an exported project). See studio_app.h.
#include "imgui.h"
#include "studio_app.h"

#include "menu.hpp"
#include "theme.hpp"

void AppInit()
{
    theme::Init();
    menu::Init();
}

void AppFrame()
{
    menu::Render();
}
