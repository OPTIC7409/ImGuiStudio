// studio_app.h - the contract between your UI code and whatever hosts it.
//
// ImGui Studio's WebGL2 host and the exported native host (native/main.cpp)
// both drive your UI through exactly these two functions, so the same C++
// runs unchanged in the browser preview and in a native application.
//
// To embed the UI in an existing native app, call AppInit() once after you
// create the Dear ImGui context and renderer backend, and AppFrame() every
// frame between ImGui::NewFrame() and ImGui::Render().

#pragma once

void AppInit();     // Load fonts, apply theme/style, initialise state.
void AppFrame();    // Submit your UI (called every frame inside NewFrame()/Render()).
