# ImGui Studio changes to the vendored Dear ImGui

Dear ImGui v1.92.9b, unmodified except for two lines in `imgui_widgets.cpp`
(marked `// [ImGui Studio patch]`):

- `BeginCombo()` and `ColorButton()` now call `IMGUI_TEST_ENGINE_ITEM_INFO(...)`
  so their labels are visible to the Studio's widget inspector (upstream only
  reports the item bounds for these two).

`IMGUI_TEST_ENGINE_ITEM_INFO` expands to nothing unless `IMGUI_ENABLE_TEST_ENGINE`
is defined, so native/exported builds compile exactly like upstream.
Projects that use their own Dear ImGui copy (`"imgui": "path"` in studio.json)
still work: unlabeled items are then resolved by hashing the label you query
against the item's ID-stack seed.
