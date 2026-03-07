#!/bin/bash

# Open Clawboard in the default browser for a quick manual smoke pass.
# The detailed checklist now lives in TESTING.md.

URL="http://localhost:3010/u"

echo "Opening Clawboard Unified View for manual smoke testing..."
echo ""
echo "URL: $URL"
echo ""
echo "Manual smoke checklist"
echo "---------------------"
echo ""
echo "1. Unified one-box composer"
echo "   - Type a draft in the top composer."
echo "   - Confirm the draft stays intact while potential matches appear."
echo "   - Verify Enter sends, Shift+Enter adds a newline, and the textarea grows."
echo ""
echo "2. Topic/task targeting"
echo "   - Select a topic and confirm the send button changes to 'New task in topic'."
echo "   - Select a task and confirm the send button changes to 'Continue task'."
echo ""
echo "3. Mobile fullscreen task chat"
echo "   - Open a task on a phone-sized viewport."
echo "   - Confirm chat is fullscreen, has clear close/status controls, and an anchored composer."
echo ""
echo "4. Stop/cancel behavior"
echo "   - Start a run and confirm Stop is visible on the right thread."
echo ""
echo "See TESTING.md for the maintained manual checklist and automated commands."
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
echo "Browser should now be open."
