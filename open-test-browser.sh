#!/bin/bash

# Open Clawboard in the default browser for manual testing
# This script opens the unified view and provides testing instructions

URL="http://localhost:3010/u"

echo "🚀 Opening Clawboard Unified View for UI Testing..."
echo ""
echo "URL: $URL"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  MANUAL UI TESTING CHECKLIST"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "✓ Test 1: Smaller Textarea"
echo "  → Look at the top composer box"
echo "  → Should be ~40px tall when empty (noticeably shorter)"
echo ""
echo "✓ Test 2: Auto-Expand"
echo "  → Type multiple lines in the textarea"
echo "  → Should expand automatically to show all content"
echo ""
echo "✓ Test 3: Sticky Topic Headers (Single-Column)"
echo "  → Expand a topic"
echo "  → Scroll down through its content"
echo "  → Topic header should stick below the composer"
echo ""
echo "✓ Test 4: Sticky Task Headers (Single-Column)"
echo "  → Expand a task within a topic"
echo "  → Scroll down through task content"
echo "  → Task header should stick below the composer"
echo ""
echo "✓ Test 5: Two-Column Mode"
echo "  → Click the '2 column' button in Board Controls"
echo "  → Sticky headers should be disabled"
echo "  → Switch back to '1 column' to re-enable sticky"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📖 For detailed testing instructions, see:"
echo "   MANUAL_UI_TEST_GUIDE.md"
echo ""
echo "Opening browser in 3 seconds..."
sleep 3

# Try different methods to open the browser
if command -v open &> /dev/null; then
    # macOS
    open "$URL"
elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open "$URL"
elif command -v start &> /dev/null; then
    # Windows
    start "$URL"
else
    echo "❌ Could not detect browser command"
    echo "Please manually open: $URL"
fi

echo ""
echo "✅ Browser should now be open"
echo "   Follow the checklist above to test the UI changes"
echo ""
