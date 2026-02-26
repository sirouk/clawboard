/**
 * Browser Console Test Script for Clawboard UI Changes
 * 
 * Instructions:
 * 1. Open http://localhost:3010/u in your browser
 * 2. Open DevTools (F12 or Cmd+Option+I on Mac)
 * 3. Go to the Console tab
 * 4. Copy and paste this entire script
 * 5. Press Enter to run
 * 
 * The script will automatically check all UI changes and report results.
 */

(function testClawboardUIChanges() {
  console.clear();
  console.log('%c🧪 Clawboard UI Changes Test', 'font-size: 20px; font-weight: bold; color: #4dabf7;');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: #868e96;');
  console.log('');

  const results = {
    passed: 0,
    failed: 0,
    warnings: 0,
    tests: []
  };

  function logTest(name, passed, details) {
    const icon = passed ? '✅' : '❌';
    const color = passed ? '#51cf66' : '#ff6b6b';
    console.log(`${icon} %c${name}`, `font-weight: bold; color: ${color};`);
    if (details) {
      console.log(`   ${details}`);
    }
    console.log('');
    
    results.tests.push({ name, passed, details });
    if (passed) results.passed++;
    else results.failed++;
  }

  function logWarning(message) {
    console.log(`⚠️  %c${message}`, 'color: #ffd43b;');
    console.log('');
    results.warnings++;
  }

  function logInfo(message) {
    console.log(`ℹ️  ${message}`);
  }

  // Test 1: Textarea Min-Height
  console.log('%c📏 Test 1: Smaller Freeform Textarea', 'font-size: 16px; font-weight: bold; color: #4dabf7;');
  const textarea = document.querySelector('textarea[placeholder*="Write freeform"]');
  
  if (textarea) {
    const style = window.getComputedStyle(textarea);
    const minHeight = style.minHeight;
    const actualHeight = textarea.offsetHeight;
    
    const passed = minHeight === '40px' || actualHeight <= 50;
    logTest(
      'Textarea min-height is 40px',
      passed,
      `min-height: ${minHeight}, actual height: ${actualHeight}px (expected: 40px or ~40-50px)`
    );
    
    if (passed) {
      logInfo('The textarea is correctly sized at the smaller height.');
    }
  } else {
    logTest('Textarea min-height is 40px', false, 'Could not find textarea element');
  }

  // Test 2: Auto-Expand Check
  console.log('%c📐 Test 2: Textarea Auto-Expand', 'font-size: 16px; font-weight: bold; color: #4dabf7;');
  if (textarea) {
    const hasOverflowHidden = window.getComputedStyle(textarea).overflow === 'hidden' || 
                              window.getComputedStyle(textarea).overflowY === 'hidden';
    const hasResizeNone = window.getComputedStyle(textarea).resize === 'none';
    
    logTest(
      'Textarea has auto-expand properties',
      hasOverflowHidden && hasResizeNone,
      `overflow-y: hidden = ${hasOverflowHidden}, resize: none = ${hasResizeNone}`
    );
    
    logInfo('To fully test auto-expand, type multiple lines and observe the textarea growing.');
  } else {
    logTest('Textarea has auto-expand properties', false, 'Could not find textarea element');
  }

  // Test 3 & 4: Sticky Headers
  console.log('%c📌 Test 3 & 4: Sticky Headers', 'font-size: 16px; font-weight: bold; color: #4dabf7;');
  
  // Check column mode
  const twoColumnMode = localStorage.getItem('clawboard.unified.twoColumn') === 'true';
  const columnModeText = twoColumnMode ? 'TWO-COLUMN' : 'SINGLE-COLUMN';
  logInfo(`Current mode: ${columnModeText}`);
  
  if (twoColumnMode) {
    logWarning('You are in TWO-COLUMN mode. Sticky headers are disabled in this mode.');
    logInfo('To test sticky headers, switch to SINGLE-COLUMN mode using the "1 column" button.');
  }

  // Find all sticky elements
  const allElements = document.querySelectorAll('*');
  const stickyElements = Array.from(allElements).filter(el => {
    const style = window.getComputedStyle(el);
    return style.position === 'sticky';
  });

  console.log(`Found ${stickyElements.length} sticky elements:`);
  
  const stickyBar = stickyElements.find(el => el.className.includes('z-30'));
  const topicHeaders = stickyElements.filter(el => el.className.includes('z-20') && !el.className.includes('z-30'));
  const taskHeaders = stickyElements.filter(el => el.className.includes('z-10') && !el.className.includes('z-20'));

  if (stickyBar) {
    logInfo(`✓ Sticky bar (z-30): Found - This is the main composer bar`);
  }

  logTest(
    'Sticky implementation is present',
    stickyElements.length > 0,
    `Found ${stickyElements.length} elements with position: sticky`
  );

  if (!twoColumnMode) {
    // In single-column mode, we should be able to find sticky headers when topics/tasks are expanded
    logInfo('In SINGLE-COLUMN mode: Expand topics and tasks to see sticky headers in action.');
    logInfo('Topic headers should have z-index: 20');
    logInfo('Task headers should have z-index: 10');
  } else {
    logInfo('In TWO-COLUMN mode: Sticky headers for topics/tasks are disabled (expected behavior).');
  }

  // Test 5: Two-Column Toggle
  console.log('%c🔀 Test 5: Two-Column Mode Toggle', 'font-size: 16px; font-weight: bold; color: #4dabf7;');
  
  const columnButton = document.querySelector('button[title*="column"]') || 
                       Array.from(document.querySelectorAll('button')).find(btn => 
                         btn.textContent.includes('column')
                       );
  
  if (columnButton) {
    const buttonText = columnButton.textContent.trim();
    logTest(
      'Column toggle button exists',
      true,
      `Button text: "${buttonText}" (${twoColumnMode ? 'Currently in 2-column' : 'Currently in 1-column'} mode)`
    );
    
    logInfo('Click the button to toggle between modes and observe sticky header behavior.');
  } else {
    logWarning('Could not find column toggle button. It may be inside a collapsed "Board controls" section.');
  }

  // Summary
  console.log('');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: #868e96;');
  console.log('%c📊 Test Summary', 'font-size: 18px; font-weight: bold; color: #4dabf7;');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: #868e96;');
  console.log('');
  console.log(`%c✅ Passed: ${results.passed}`, 'color: #51cf66; font-weight: bold;');
  console.log(`%c❌ Failed: ${results.failed}`, 'color: #ff6b6b; font-weight: bold;');
  console.log(`%c⚠️  Warnings: ${results.warnings}`, 'color: #ffd43b; font-weight: bold;');
  console.log('');

  if (results.failed === 0 && results.passed > 0) {
    console.log('%c🎉 All automated checks passed!', 'font-size: 16px; color: #51cf66; font-weight: bold;');
    console.log('');
    console.log('Manual verification steps:');
    console.log('1. Type multiple lines in the textarea to verify auto-expand');
    console.log('2. Expand topics and scroll to verify sticky headers (single-column mode)');
    console.log('3. Expand tasks and scroll to verify sticky headers (single-column mode)');
    console.log('4. Toggle to 2-column mode and verify sticky headers are disabled');
  } else if (results.failed > 0) {
    console.log('%c⚠️  Some tests failed. Review the details above.', 'font-size: 16px; color: #ff6b6b; font-weight: bold;');
  }

  console.log('');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: #868e96;');
  console.log('');
  console.log('💡 Tip: Expand "Board controls" at the top to access column toggle and other settings.');
  console.log('');

  // Return results for programmatic access
  return results;
})();
