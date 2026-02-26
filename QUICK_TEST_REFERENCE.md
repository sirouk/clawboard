# Quick Test Reference Card

## 🚀 Fast Start

```bash
# Open browser with test checklist
./open-test-browser.sh

# Or manually open
open http://localhost:3010/u
```

## ✅ 5-Minute Test Checklist

### 1. Textarea Height (30 seconds)
- [ ] Look at top composer box
- [ ] Should be ~40px tall (shorter than before)

### 2. Auto-Expand (30 seconds)
- [ ] Type 4-5 lines in textarea
- [ ] Should grow automatically
- [ ] No scrollbar inside

### 3. Sticky Topic Header (1 minute)
- [ ] Expand a topic
- [ ] Scroll down through content
- [ ] Header should stick at top

### 4. Sticky Task Header (1 minute)
- [ ] Expand a task inside topic
- [ ] Scroll down through task
- [ ] Header should stick below topic

### 5. Two-Column Mode (1 minute)
- [ ] Click "2 column" button
- [ ] Sticky should be disabled
- [ ] Click "1 column" to re-enable

## 🔍 Browser Console Quick Test

```javascript
// Paste this in DevTools Console (F12)
const t = document.querySelector('textarea[placeholder*="Write freeform"]');
console.log('Min-height:', window.getComputedStyle(t).minHeight); // Should be 40px
console.log('Actual height:', t.offsetHeight + 'px'); // Should be ~40-44px
```

## 📊 Expected Results

| Test | Expected Behavior |
|------|-------------------|
| Textarea | ~40px height when empty |
| Auto-expand | Grows with content, no scrollbar |
| Topic sticky | Header visible when scrolling (1-col) |
| Task sticky | Header visible when scrolling (1-col) |
| 2-column | Sticky disabled |

## 🐛 If Something's Wrong

1. **Textarea not shorter?**
   - Check: `min-h-[40px]` class present
   - Verify: No custom CSS overriding it

2. **Not auto-expanding?**
   - Check: `overflow-y-hidden` present
   - Try: Typing more lines

3. **Headers not sticky?**
   - Check: In single-column mode (not 2-column)
   - Verify: Topic/task is expanded
   - Try: Scrolling more

4. **Can't find 2-column button?**
   - Look for: "Board controls" section
   - Click to expand it

## 📁 Full Documentation

- `MANUAL_UI_TEST_GUIDE.md` - Detailed instructions
- `browser-console-test.js` - Automated console test
- `UI_CHANGES_TEST_REPORT.md` - Complete report
- `TEST_RESULTS_SUMMARY.md` - Status overview

## 💡 Pro Tips

- Use DevTools (F12) to inspect elements
- Check "Computed" tab for actual CSS values
- Test at different scroll positions
- Try with multiple topics/tasks expanded
- Test on different screen sizes

---

**All changes verified in code ✅**  
**Ready for manual testing ✅**
