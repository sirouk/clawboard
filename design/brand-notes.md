# OpenClaw Visual Language for Clawboard

## Palette
- **Background**: Deep Navy (`#070A13`) - The primary canvas.
- **Surface**: Translucent Slate/Navy (`rgba(7, 10, 19, 0.8)` or `#0F172A`) - Used for headers, cards, and navigation.
- **Primary Accent (Coral/Red)**: `#FF4D4D` - High-energy action color, used sparingly for critical status or primary CTAs.
- **Secondary Accent (Teal)**: `#2DD4BF` - System pulses, success states, and secondary highlights.
- **Amber/Gold**: `#F9BF1F` - Legacy OpenClaw accent, use for "caution" or "active/doing" states.
- **Text (Primary)**: `#F8FAFC` - High contrast for readability.
- **Text (Secondary)**: `#94A3B8` - Subdued for metadata and timestamps.
- **Border**: `#1F2A3D` - Subtle separation between elements.

## Typography
- **Primary**: `ui-sans-serif, system-ui, sans-serif`
- **Headings**: Semi-bold to Bold, tight tracking.
- **Body**: Regular, legible line-height (1.6).
- **Monospace**: For status codes, API paths, and commit hashes.

## Spacing & Layout
- **Gutter**: 24px (standard page padding).
- **Card Gap**: 16px.
- **Max Width**: 1200px centered for content readability.
- **Margins**: Generous vertical breathing room for feed items.

## Component Motifs
- **Chips**: Pill-shaped, semi-transparent background, subtle border (`1px solid`). Used for Topic/Agent labels.
- **Pill CTAs**: Fully rounded corners (`radius: 9999px`) for high-level actions (e.g., "Add Log").
- **Cards**: Flat design with subtle borders. Hover effects should include a light "glow" or border-color shift to Teal or Amber.
- **Glows**: Subtle radial gradients behind key status icons or headers to create a "premium dark" depth.
- **Shadows**: Deep, soft shadows for elevated modals or dropdowns.

## UI Suggestions

### 1. Topics Page: "Command Center" Grid
- **Design**: 3-column grid of cards.
- **Visuals**: Each card uses the `surface` color with a `border` that shifts to `secondary-teal` on hover.
- **Content**: Topic name (bold), task progress bar (teal), and a "Latest Activity" snippet in `text-secondary`.
- **Accent**: Use a tiny glowing dot (Teal/Amber) to indicate if an agent is currently active in that topic.

### 2. Topic Detail: "Deep Focus" View
- **Design**: Two-pane layout (Left: Activity Log feed, Right: Task Checklist).
- **Visuals**: Activity log entries are separated by subtle horizontal lines (`border`). Task items use `pill` checkboxes.
- **Accent**: The "Add Log" button at the bottom is a fixed `pill` floating button in `brand-primary` (Coral) to make it the clear primary action.

### 3. Coverage: "System Pulse" Map
- **Design**: A visual density map or a clean table of "Time vs Topic".
- **Visuals**: Use different opacity levels of `brand-secondary` (Teal) to show activity density.
- **Content**: Highlight gaps in coverage (areas with no recent logs) using the `brand-primary` (Coral) as a warning/low-density signal.
- **Interactivity**: Clicking a cell jumps to the filtered Log view for that time/topic.
