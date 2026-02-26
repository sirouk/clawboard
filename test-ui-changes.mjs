#!/usr/bin/env node
/**
 * UI Changes Testing Script for Clawboard Unified View
 * 
 * This script tests the following changes:
 * 1. Smaller freeform textarea (min-height: 40px instead of 72px)
 * 2. Auto-expand textarea on multiple lines
 * 3. Sticky topic headers in single-column mode
 * 4. Sticky task headers in single-column mode
 * 5. Two-column mode disables sticky headers
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL = 'http://localhost:3010/u';
const SCREENSHOTS_DIR = './test-screenshots';

// Create screenshots directory
try {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
} catch (e) {
  // Directory already exists
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testUIChanges() {
  console.log('🚀 Starting UI changes test...\n');
  
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 500 // Slow down for visibility
  });
  
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });
  
  const page = await context.newPage();
  
  const results = {
    timestamp: new Date().toISOString(),
    tests: []
  };

  try {
    // Navigate to the page
    console.log('📍 Navigating to', BASE_URL);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(2000); // Wait for React to hydrate
    
    // Test 1: Check textarea min-height
    console.log('\n✅ Test 1: Checking freeform textarea height...');
    
    // Try multiple selectors to find the textarea
    let textarea;
    try {
      textarea = page.locator('textarea[placeholder*="Write freeform"]').first();
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
    } catch (e) {
      console.log('   Trying alternative textarea selector...');
      textarea = page.locator('textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
    }
    
    const textareaBox = await textarea.boundingBox();
    const computedStyle = await textarea.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        minHeight: style.minHeight,
        height: style.height,
        actualHeight: el.offsetHeight
      };
    });
    
    console.log('   Textarea dimensions:', {
      minHeight: computedStyle.minHeight,
      actualHeight: computedStyle.actualHeight,
      expectedMinHeight: '40px'
    });
    
    const test1Pass = computedStyle.minHeight === '40px' || computedStyle.actualHeight <= 50;
    results.tests.push({
      name: 'Smaller textarea (min-height: 40px)',
      passed: test1Pass,
      details: computedStyle,
      expected: 'min-height: 40px or actual height ~40-50px',
      actual: `min-height: ${computedStyle.minHeight}, actual: ${computedStyle.actualHeight}px`
    });
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, '01-textarea-empty-state.png'),
      fullPage: false
    });
    console.log('   📸 Screenshot saved: 01-textarea-empty-state.png');
    
    // Test 2: Auto-expand textarea
    console.log('\n✅ Test 2: Testing textarea auto-expand...');
    const multilineText = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await textarea.fill(multilineText);
    await sleep(500);
    
    const expandedBox = await textarea.boundingBox();
    const expandedStyle = await textarea.evaluate(el => ({
      height: el.offsetHeight,
      scrollHeight: el.scrollHeight
    }));
    
    console.log('   Expanded textarea:', {
      height: expandedStyle.height,
      scrollHeight: expandedStyle.scrollHeight
    });
    
    const test2Pass = expandedStyle.height > 60; // Should be taller than min-height
    results.tests.push({
      name: 'Textarea auto-expand',
      passed: test2Pass,
      details: expandedStyle,
      expected: 'Height increases with content (>60px)',
      actual: `${expandedStyle.height}px`
    });
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, '02-textarea-expanded.png'),
      fullPage: false
    });
    console.log('   📸 Screenshot saved: 02-textarea-expanded.png');
    
    // Clear textarea
    await textarea.clear();
    await sleep(300);
    
    // Test 3 & 4: Sticky headers in single-column mode
    console.log('\n✅ Test 3 & 4: Testing sticky headers in single-column mode...');
    
    // First, ensure we're in single-column mode
    const twoColumnButton = page.locator('button:has-text("column")').first();
    const buttonText = await twoColumnButton.textContent();
    
    if (buttonText?.includes('1 column')) {
      // We're in 2-column mode, need to switch to 1-column
      console.log('   Switching to single-column mode...');
      await twoColumnButton.click();
      await sleep(500);
    }
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, '03-single-column-mode.png'),
      fullPage: true
    });
    console.log('   📸 Screenshot saved: 03-single-column-mode.png');
    
    // Find an expanded topic
    const topics = page.locator('[role="button"]').filter({ hasText: /topic|task/i });
    const topicCount = await topics.count();
    console.log(`   Found ${topicCount} potential topics/tasks`);
    
    // Try to find and expand a topic if not already expanded
    const topicHeaders = page.locator('div').filter({ 
      has: page.locator('text=/topic|task/i') 
    });
    
    // Look for topic cards
    const topicCards = page.locator('[class*="rounded"]').filter({
      has: page.locator('text=/./') // Has some text
    });
    
    console.log('   Looking for expandable topics...');
    await sleep(1000);
    
    // Scroll down to see if headers stick
    console.log('   Scrolling to test sticky behavior...');
    await page.evaluate(() => window.scrollBy(0, 300));
    await sleep(500);
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, '04-scrolled-sticky-test.png'),
      fullPage: false
    });
    console.log('   📸 Screenshot saved: 04-scrolled-sticky-test.png');
    
    // Check for sticky elements
    const stickyElements = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('[class*="sticky"]'));
      return elements.map(el => ({
        tagName: el.tagName,
        classes: el.className,
        text: el.textContent?.substring(0, 50),
        position: window.getComputedStyle(el).position,
        top: window.getComputedStyle(el).top,
        zIndex: window.getComputedStyle(el).zIndex
      }));
    });
    
    console.log('   Found sticky elements:', stickyElements.length);
    stickyElements.forEach((el, i) => {
      console.log(`     ${i + 1}. ${el.tagName} - position: ${el.position}, top: ${el.top}, z-index: ${el.zIndex}`);
    });
    
    const test3Pass = stickyElements.some(el => 
      el.position === 'sticky' && el.classes.includes('z-20')
    );
    
    results.tests.push({
      name: 'Sticky topic headers (single-column)',
      passed: test3Pass,
      details: { stickyElementsFound: stickyElements.length },
      expected: 'Topic headers with sticky positioning and z-20',
      actual: `Found ${stickyElements.length} sticky elements`
    });
    
    const test4Pass = stickyElements.some(el => 
      el.position === 'sticky' && el.classes.includes('z-10')
    );
    
    results.tests.push({
      name: 'Sticky task headers (single-column)',
      passed: test4Pass,
      details: { stickyElementsFound: stickyElements.length },
      expected: 'Task headers with sticky positioning and z-10',
      actual: `Found ${stickyElements.length} sticky elements`
    });
    
    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
    
    // Test 5: Two-column mode disables sticky
    console.log('\n✅ Test 5: Testing two-column mode (sticky disabled)...');
    
    const columnButton = page.locator('button:has-text("column")').first();
    await columnButton.click();
    await sleep(500);
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, '05-two-column-mode.png'),
      fullPage: true
    });
    console.log('   📸 Screenshot saved: 05-two-column-mode.png');
    
    // Scroll and check sticky behavior in 2-column mode
    await page.evaluate(() => window.scrollBy(0, 300));
    await sleep(500);
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, '06-two-column-scrolled.png'),
      fullPage: false
    });
    console.log('   📸 Screenshot saved: 06-two-column-scrolled.png');
    
    const stickyInTwoColumn = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('[class*="sticky"]'));
      return elements.filter(el => {
        const style = window.getComputedStyle(el);
        const classes = el.className;
        // Check if it's a topic/task header that should NOT be sticky in 2-column
        return style.position === 'sticky' && 
               (classes.includes('z-20') || classes.includes('z-10')) &&
               !classes.includes('z-30'); // Exclude the main sticky bar
      }).length;
    });
    
    console.log('   Sticky topic/task headers in 2-column mode:', stickyInTwoColumn);
    
    const test5Pass = stickyInTwoColumn === 0;
    results.tests.push({
      name: 'Two-column mode disables sticky headers',
      passed: test5Pass,
      details: { stickyHeadersFound: stickyInTwoColumn },
      expected: 'No sticky topic/task headers in 2-column mode',
      actual: `Found ${stickyInTwoColumn} sticky headers`
    });
    
  } catch (error) {
    console.error('❌ Error during testing:', error);
    results.error = error.message;
    
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, 'error-state.png'),
      fullPage: true
    });
  } finally {
    await browser.close();
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(60));
  
  const passed = results.tests.filter(t => t.passed).length;
  const total = results.tests.length;
  
  results.tests.forEach((test, i) => {
    const icon = test.passed ? '✅' : '❌';
    console.log(`\n${icon} Test ${i + 1}: ${test.name}`);
    console.log(`   Expected: ${test.expected}`);
    console.log(`   Actual: ${test.actual}`);
    console.log(`   Status: ${test.passed ? 'PASSED' : 'FAILED'}`);
  });
  
  console.log('\n' + '='.repeat(60));
  console.log(`Overall: ${passed}/${total} tests passed`);
  console.log('='.repeat(60));
  
  // Save results to JSON
  const resultsPath = join(SCREENSHOTS_DIR, 'test-results.json');
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${resultsPath}`);
  console.log(`📁 Screenshots saved to: ${SCREENSHOTS_DIR}/`);
  
  return results;
}

// Run the tests
testUIChanges().catch(console.error);
