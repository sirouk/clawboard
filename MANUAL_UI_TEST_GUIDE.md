# Manual UI Testing Guide for Clawboard Unified View

## Test URL
`http://localhost:3010/u`

## Changes to Test

### 1. **Smaller Freeform Textarea** ✓
**What changed:** The top composer/input box now has a reduced min-height (40px instead of 72px)

**How to test:**
1. Open `http://localhost:3010/u` in your browser
2. Look at the freeform textarea at the top (placeholder: "Write freeform notes or search...")
3. **Expected:** The textarea should appear noticeably shorter when empty (~40px height)
4. **Previous behavior:** It was taller at 72px min-height

**Visual check:**
- The textarea should look more compact and take up less vertical space
- It should still be comfortable to click and type in

---

### 2. **Auto-Expand Textarea** ✓
**What changed:** The textarea still auto-expands as you type multiple lines

**How to test:**
1. Click into the freeform textarea
2. Type several lines of text (press Enter between lines):
   ```
   Line 1
   Line 2
   Line 3
   Line 4
   ```
3. **Expected:** The textarea should grow taller as you add more lines
4. The textarea should smoothly expand to show all your content

**Visual check:**
- No scrollbar should appear inside the textarea
- All text should be visible
- The textarea should grow vertically

---

### 3. **Sticky Topic Headers (Single-Column Mode)** ✓
**What changed:** When a topic is expanded, its header sticks below the freeform input box as you scroll

**How to test:**
1. Make sure you're in **single-column mode** (if you see a "2 column" button, you're in single-column)
2. Find a topic on the board and click to expand it
3. Scroll down through the topic's content (tasks, messages, etc.)
4. **Expected:** The topic header should "stick" just below the composer bar at the top
5. The header should have:
   - A gradient background (topic color fading to dark)
   - A border at the bottom
   - Backdrop blur effect
   - z-index of 20

**Visual check:**
- As you scroll down, the topic header should remain visible at the top
- It should stay positioned below the sticky composer bar
- The header should not scroll away with the content

**Code reference:**
```tsx
// Line 5842-5843 in unified-view.tsx
isExpanded && !showTwoColumns && !topicChatFullscreen
  ? "sticky z-20 -mx-4 px-4 py-2 border-b border-[rgb(var(--claw-border))] backdrop-blur md:-mx-5 md:px-5"
```

---

### 4. **Sticky Task Headers (Single-Column Mode)** ✓
**What changed:** When a task is expanded inside a topic, its header also sticks as you scroll

**How to test:**
1. Still in **single-column mode**
2. Expand a topic, then expand a task within that topic
3. Scroll down through the task's content (messages, logs, etc.)
4. **Expected:** The task header should stick below the composer bar
5. The task header should have:
   - A gradient background (task color)
   - A border at the bottom
   - Backdrop blur effect
   - z-index of 10 (lower than topic headers)

**Visual check:**
- The task header should remain visible as you scroll through task content
- If both topic and task headers are visible, the topic header (z-20) should appear above the task header (z-10)
- The task header should not scroll away

**Code reference:**
```tsx
// Line 6426-6427 in unified-view.tsx
taskExpanded && !showTwoColumns && !taskChatFullscreen
  ? "sticky z-10 -mx-3.5 border-b border-[rgb(var(--claw-border))] px-3.5 py-2 backdrop-blur sm:-mx-4 sm:px-4"
```

---

### 5. **Two-Column Mode Disables Sticky Headers** ✓
**What changed:** Sticky headers are disabled when in two-column mode

**How to test:**
1. Look for the "Board controls" section or a button that says "2 column" or "1 column"
2. If you see "2 column", click it to enable two-column mode
3. The button should change to say "1 column" (indicating you're now in 2-column mode)
4. Expand topics and tasks
5. Scroll down
6. **Expected:** Topic and task headers should NOT stick - they should scroll normally with the content

**Visual check:**
- In 2-column mode, headers should behave like normal headers (not sticky)
- The `showTwoColumns` condition prevents the sticky classes from being applied
- Switch back to single-column mode ("1 column" button) and verify sticky behavior returns

**Code logic:**
```tsx
// The sticky classes are only applied when:
isExpanded && !showTwoColumns && !topicChatFullscreen
```

---

## Quick Test Checklist

- [ ] Textarea is shorter when empty (~40px)
- [ ] Textarea expands when typing multiple lines
- [ ] Topic headers stick in single-column mode
- [ ] Task headers stick in single-column mode (below topic headers)
- [ ] Sticky headers are disabled in two-column mode
- [ ] Switching between modes works correctly

---

## Screenshots to Capture

1. **Empty textarea** - Show the reduced height
2. **Expanded textarea** - Show auto-expansion with multiple lines
3. **Sticky topic header** - Scrolled down with topic header visible
4. **Sticky task header** - Scrolled down with task header visible
5. **Two-column mode** - Show that headers don't stick
6. **Single-column scrolled** - Show both topic and task headers sticking together

---

## Technical Details

### Textarea Changes
- **File:** `src/components/unified-view.tsx`
- **Line:** 5551
- **Class:** `min-h-[40px] resize-none overflow-y-hidden border-0 bg-transparent p-2 pr-[11.5rem]`

### Sticky Bar Reference
- **Ref:** `stickyBarRef` (line 1971)
- **Height state:** `stickyBarHeight` (line 1972)
- **Used for:** Setting the `top` position of sticky headers

### Topic Header Sticky
- **Lines:** 5842-5852
- **Condition:** `isExpanded && !showTwoColumns && !topicChatFullscreen`
- **Z-index:** 20

### Task Header Sticky
- **Lines:** 6426-6433
- **Condition:** `taskExpanded && !showTwoColumns && !taskChatFullscreen`
- **Z-index:** 10

### Two-Column Toggle
- **State:** `twoColumn` (line 1580)
- **Computed:** `showTwoColumns = twoColumn && mdUp` (line 1600)
- **Toggle function:** `toggleTwoColumn` (line 1616)
- **Button text:** Shows "1 column" when in 2-column mode, "2 column" when in single-column mode

---

## Browser DevTools Inspection

### To verify textarea height:
```javascript
// In browser console:
const textarea = document.querySelector('textarea[placeholder*="Write freeform"]');
console.log('Min-height:', window.getComputedStyle(textarea).minHeight);
console.log('Actual height:', textarea.offsetHeight);
// Expected: minHeight = "40px", offsetHeight ≈ 40-44px
```

### To verify sticky positioning:
```javascript
// Find sticky elements:
const stickyElements = document.querySelectorAll('[class*="sticky"]');
stickyElements.forEach(el => {
  const style = window.getComputedStyle(el);
  if (style.position === 'sticky') {
    console.log('Sticky element:', {
      text: el.textContent.substring(0, 50),
      position: style.position,
      top: style.top,
      zIndex: style.zIndex
    });
  }
});
```

### To check column mode:
```javascript
// Check localStorage:
console.log('Two-column mode:', localStorage.getItem('clawboard.unified.twoColumn'));
// "true" = 2-column mode, "false" or null = single-column mode
```

---

## Notes

- The sticky bar at the very top (with the composer) is always sticky (z-30)
- Topic headers stick with z-20 (higher priority)
- Task headers stick with z-10 (lower priority, below topic headers)
- Sticky behavior only works in single-column mode on medium+ screens
- The `stickyBarHeight` is calculated dynamically to position headers correctly
