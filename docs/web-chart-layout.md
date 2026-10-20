# Web chart layout

`apps/web/components/chat/artifact-renderer.tsx` owns the presentation of all seven structured chart artifacts: Bazi, Ziwei, Liuyao, Jingzhan, Qimen, Liuren, and Meihua. Calculation results and formatter text remain authoritative; layout changes must preserve the supplied data and the copy-text action.

## Fitted charts

Every chart goes through `ResponsiveArtifactFrame`. Mark its bounded scroll region with `data-artifact-viewport`. The chat workspace, shared conversations, preview sheets, and full-screen viewer supply this boundary. Its height must be independent of the fitted chart's height. Preview results use `BottomSheet.fillHeight` to establish a definite desktop height as well as a definite mobile height.

The frame measures the current container width and unscaled chart height. It deducts scroll-region padding and space for the chart actions, then scales uniformly to fit. `ResizeObserver` tracks the chart, container, and scroll region; window and visual-viewport resize events also trigger measurement. Content width is recalculated from the live container on each measurement, so resizing from desktop to mobile cannot retain a previous desktop width.

Chat fitting depends on the scroll region's dimensions, never the message's position. `fitViewportHeight` additionally deducts content above a chart in a preview. That offset includes `scrollTop` so scrolling cannot change the chart's size.

The visual wrapper clips the unscaled layout overflow and reserves only the scaled height. Without this boundary, CSS transforms can leave an invisible full-size scroll area below a chart.

## Chart content

The frame establishes the named `artifact` inline-size container. Chart breakpoints use its width, with compact layouts below 480px and the Liuyao table layout starting at 640px. Window-width breakpoints are unsuitable here: a wide browser can still contain a narrow chat column, and a zoomed chart can be wider than the screen. Ziwei and Qimen retain at least 320px of unscaled layout width before fitting, keeping palace contents and star/stem columns intact on narrow screens.

Ziwei retains the traditional twelve-palace order in a four-by-four grid with a 2:3 width-to-height ratio. Fixed minimum palace heights must not return. Its preferred layout width also respects the available height before scaling. Selecting a palace displays complete star, brightness, transformation, and cycle details in the center panel without changing the board geometry. Palace controls support keyboard activation.

`ChartDetails` contains supplementary scripture and commentary. Closed sections leave the full chart visible. Opening a section retains width fitting and releases height fitting so long text can be read at its normal size rather than shrinking the entire chart. These sections use native `details` elements marked with `data-artifact-details`.

## Full-screen reading

Every chart offers the same full-screen action, including artifacts without formatter text. The native modal dialog provides a fitted overview and explicit zoom controls. Zoomed reading uses a minimum content width of 720px and scrolls within the viewer. Returning to the fitted overview restores the chart's normal layout limits. The controls remain outside the chart's scaling boundary.

One React portal owns each chart. Its container moves between the inline frame and the viewer, preserving the selected Bazi year, selected Ziwei palace, and open detail sections. Rendering a second chart instance would silently reset these selections when opening the viewer.

Escape closes the viewer and returns focus to its trigger. A viewer opened from a preview must consume Escape and Tab before the underlying sheet's handlers receive them. Opening the viewer must remain idempotent when React repeats effect setup in development.

## Composer

The composer places chart and send actions beside the textarea, with the model selector below the text. A single-line textarea stays compact, grows with input to 128px, and collapses after clearing. Keep its 16px input font and the existing IME handling, editable draft during generation, and stop behavior.
