#include "icons.h"
#include "imgui_internal.h"
#include <cmath>

namespace ui
{
    namespace
    {
        inline ImVec2 P(ImVec2 c, float u, float x, float y) { return ImVec2(c.x + x * u, c.y + y * u); }

        void Line(ImDrawList* dl, ImVec2 a, ImVec2 b, ImU32 col, float w)
        {
            dl->AddLine(a, b, col, w);
            // Round caps keep strokes consistent with the circle-based glyphs.
            dl->AddCircleFilled(a, w * 0.5f, col, 8);
            dl->AddCircleFilled(b, w * 0.5f, col, 8);
        }
    }

    void DrawChevron(ImDrawList* dl, ImVec2 c, float size, ImU32 col, float stroke, float t)
    {
        const float u = size / 16.0f;
        const float dy = 2.0f * (1.0f - 2.0f * t);
        ImVec2 pts[3] = { P(c, u, -4.0f, -dy), P(c, u, 0.0f, dy), P(c, u, 4.0f, -dy) };
        dl->AddPolyline(pts, 3, col, ImDrawFlags_None, stroke);
    }

    void DrawIcon(ImDrawList* dl, Icon icon, ImVec2 c, float size, ImU32 col, float w)
    {
        // Glyphs are authored on a 16x16 grid centred at (0,0): coordinates in [-8, 8].
        const float u = size / 16.0f;
        switch (icon)
        {
        case Icon::General:
        {
            const float ys[3] = { -4.5f, 0.0f, 4.5f };
            const float ks[3] = { 2.5f, -3.0f, 1.0f };
            for (int i = 0; i < 3; i++)
            {
                Line(dl, P(c, u, -6.5f, ys[i]), P(c, u, 6.5f, ys[i]), col, w);
                dl->AddCircleFilled(P(c, u, ks[i], ys[i]), 2.4f * u, col, 12);
            }
            break;
        }
        case Icon::Audio:
        {
            const float hs[5] = { 2.5f, 5.5f, 7.0f, 4.0f, 1.8f };
            for (int i = 0; i < 5; i++)
            {
                float x = -6.0f + i * 3.0f;
                Line(dl, P(c, u, x, -hs[i]), P(c, u, x, hs[i]), col, w);
            }
            break;
        }
        case Icon::Midi:
        {
            dl->AddRect(P(c, u, -6.5f, -5.5f), P(c, u, 6.5f, 5.5f), col, 2.0f * u, 0, w);
            Line(dl, P(c, u, -2.2f, 0.5f), P(c, u, -2.2f, 5.0f), col, w);
            Line(dl, P(c, u, 2.2f, 0.5f), P(c, u, 2.2f, 5.0f), col, w);
            dl->AddRectFilled(P(c, u, -3.4f, -5.0f), P(c, u, -1.0f, 1.2f), col, 0.8f * u);
            dl->AddRectFilled(P(c, u, 1.0f, -5.0f), P(c, u, 3.4f, 1.2f), col, 0.8f * u);
            break;
        }
        case Icon::Appearance:
        {
            dl->AddCircle(c, 6.5f * u, col, 24, w);
            dl->PathArcTo(c, 6.5f * u, -IM_PI * 0.5f, IM_PI * 0.5f, 16);
            dl->PathFillConvex(col);
            break;
        }
        case Icon::Shortcuts:
        {
            dl->AddRect(P(c, u, -7.0f, -4.5f), P(c, u, 7.0f, 4.5f), col, 2.0f * u, 0, w);
            for (int i = 0; i < 4; i++)
                dl->AddCircleFilled(P(c, u, -4.2f + i * 2.8f, -1.6f), 0.95f * u, col, 8);
            Line(dl, P(c, u, -3.0f, 1.8f), P(c, u, 3.0f, 1.8f), col, w);
            break;
        }
        case Icon::Chevron:
            DrawChevron(dl, c, size, col, w, 0.0f);
            break;
        case Icon::Check:
        {
            ImVec2 pts[3] = { P(c, u, -4.5f, 0.2f), P(c, u, -1.3f, 3.4f), P(c, u, 4.8f, -3.2f) };
            dl->AddPolyline(pts, 3, col, ImDrawFlags_None, w);
            break;
        }
        case Icon::Folder:
        {
            dl->PathLineTo(P(c, u, -7.0f, -4.5f));
            dl->PathLineTo(P(c, u, -2.5f, -4.5f));
            dl->PathLineTo(P(c, u, -1.0f, -2.8f));
            dl->PathLineTo(P(c, u, 7.0f, -2.8f));
            dl->PathLineTo(P(c, u, 7.0f, 5.0f));
            dl->PathLineTo(P(c, u, -7.0f, 5.0f));
            dl->PathStroke(col, ImDrawFlags_Closed, w);
            break;
        }
        case Icon::Logo:
        {
            const float hs[5] = { 1.6f, 4.2f, 6.0f, 3.4f, 1.4f };
            for (int i = 0; i < 5; i++)
            {
                float x = -5.6f + i * 2.8f;
                Line(dl, P(c, u, x, -hs[i]), P(c, u, x, hs[i]), col, w);
            }
            break;
        }
        }
    }
}
