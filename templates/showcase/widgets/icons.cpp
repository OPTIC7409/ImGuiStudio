// icons.cpp - resolution independent line icons drawn with ImDrawList paths.
#include "widgets.hpp"

#include <cmath>

namespace ui
{
    void DrawIcon(ImDrawList* dl, Icon icon, const ImVec2& c, float size, ImU32 col, float th, float rot)
    {
        const float s = size * 0.5f;
        const float cr = cosf(rot);
        const float sr = sinf(rot);
        auto P = [&](float x, float y) { return ImVec2(c.x + (x * cr - y * sr) * s, c.y + (x * sr + y * cr) * s); };
        auto line = [&](float x0, float y0, float x1, float y1) { dl->AddLine(P(x0, y0), P(x1, y1), col, th); };

        switch (icon)
        {
        case Icon::General:
        {
            // Three sliders
            const float ys[3] = { -0.6f, 0.0f, 0.6f };
            const float ks[3] = { -0.35f, 0.4f, -0.05f };
            for (int i = 0; i < 3; i++)
            {
                const float r = 0.2f;
                line(-0.85f, ys[i], ks[i] - r, ys[i]);
                line(ks[i] + r, ys[i], 0.85f, ys[i]);
                dl->AddCircle(P(ks[i], ys[i]), r * s, col, 16, th);
            }
            break;
        }
        case Icon::Monitor:
            dl->AddRect(P(-0.9f, -0.72f), P(0.9f, 0.42f), col, 0.18f * s, 0, th);
            line(0.0f, 0.42f, 0.0f, 0.78f);
            line(-0.42f, 0.8f, 0.42f, 0.8f);
            break;
        case Icon::Speaker:
            dl->PathLineTo(P(-0.85f, -0.3f));
            dl->PathLineTo(P(-0.45f, -0.3f));
            dl->PathLineTo(P(0.0f, -0.72f));
            dl->PathLineTo(P(0.0f, 0.72f));
            dl->PathLineTo(P(-0.45f, 0.3f));
            dl->PathLineTo(P(-0.85f, 0.3f));
            dl->PathStroke(col, ImDrawFlags_Closed, th);
            dl->PathArcTo(P(0.05f, 0.0f), 0.42f * s, -0.85f + rot, 0.85f + rot, 12);
            dl->PathStroke(col, 0, th);
            dl->PathArcTo(P(0.05f, 0.0f), 0.8f * s, -0.9f + rot, 0.9f + rot, 16);
            dl->PathStroke(col, 0, th);
            break;
        case Icon::Keyboard:
            dl->AddRect(P(-0.95f, -0.6f), P(0.95f, 0.6f), col, 0.2f * s, 0, th);
            for (int row = 0; row < 2; row++)
                for (int k = 0; k < 4; k++)
                {
                    const ImVec2 kc = P(-0.54f + k * 0.36f, -0.24f + row * 0.3f);
                    dl->AddRectFilled(ImVec2(kc.x - 0.07f * s, kc.y - 0.07f * s), ImVec2(kc.x + 0.07f * s, kc.y + 0.07f * s), col, 1.0f);
                }
            line(-0.4f, 0.34f, 0.4f, 0.34f);
            break;
        case Icon::Palette:
        {
            dl->PathArcTo(c, 0.86f * s, 0.9f, 2.0f * 3.14159265f + 0.35f, 32);
            dl->PathLineTo(P(0.3f, 0.35f));
            dl->PathStroke(col, 0, th);
            const float a[4] = { -2.4f, -1.6f, -0.8f, 2.8f };
            for (float ang : a)
                dl->AddCircleFilled(P(0.5f * cosf(ang), 0.5f * sinf(ang)), 0.13f * s, col, 12);
            break;
        }
        case Icon::Search:
            dl->AddCircle(P(-0.15f, -0.15f), 0.58f * s, col, 24, th);
            line(0.28f, 0.28f, 0.82f, 0.82f);
            break;
        case Icon::Check:
            dl->PathLineTo(P(-0.72f, 0.02f));
            dl->PathLineTo(P(-0.22f, 0.52f));
            dl->PathLineTo(P(0.75f, -0.52f));
            dl->PathStroke(col, 0, th);
            break;
        case Icon::Chevron:
            dl->PathLineTo(P(-0.55f, -0.22f));
            dl->PathLineTo(P(0.0f, 0.3f));
            dl->PathLineTo(P(0.55f, -0.22f));
            dl->PathStroke(col, 0, th);
            break;
        case Icon::Close:
            line(-0.6f, -0.6f, 0.6f, 0.6f);
            line(0.6f, -0.6f, -0.6f, 0.6f);
            break;
        case Icon::Info:
            dl->AddCircle(c, 0.86f * s, col, 24, th);
            line(0.0f, -0.05f, 0.0f, 0.45f);
            dl->AddCircleFilled(P(0.0f, -0.38f), 0.09f * s, col, 8);
            break;
        case Icon::Sparkle:
        case Icon::Logo:
        {
            const ImVec2 pts[8] = { P(0, -1), P(0.2f, -0.2f), P(1, 0), P(0.2f, 0.2f), P(0, 1), P(-0.2f, 0.2f), P(-1, 0), P(-0.2f, -0.2f) };
            dl->AddConcavePolyFilled(pts, 8, col);
            break;
        }
        case Icon::Bolt:
        {
            const ImVec2 pts[6] = { P(0.12f, -1.0f), P(-0.62f, 0.14f), P(-0.04f, 0.14f), P(-0.16f, 1.0f), P(0.62f, -0.18f), P(0.04f, -0.18f) };
            dl->AddConcavePolyFilled(pts, 6, col);
            break;
        }
        case Icon::None:
            break;
        }
    }
}
