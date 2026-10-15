# AI-Assisted Test Case Generation for Mobile and Web UI Applications

An AI-driven system that autonomously explores a live web or mobile application, understands what its UI elements do, and generates structured, executable functional test cases — without a human writing a single line of test script.

Given nothing but a URL or an app, the system opens it, interacts with it the way a real tester would, reasons about what it finds using an LLM, and produces JSON test cases ready to be converted into executable Playwright/Appium scripts.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Approach](#approach)
- [Database](#database)
- [Tech Stack](#tech-stack)
- [Team](#team)

---

## Problem Statement

Once an application is deployed, it needs to be tested from a real user's perspective — do the buttons work, do forms accept input correctly, does navigation behave as expected. This gets difficult fast when applications are dynamic and UIs change frequently, because every UI change breaks hand-written test scripts.

This project explores whether an LLM, given structured (or visual) information about a live UI, can autonomously explore an application like a human tester would, and generate meaningful functional test cases without any human intervention.

## Approach

The system uses two complementary approaches to understanding a UI:

- **Structure-based (Architecture A)** — extracts information directly from the DOM (web) or the mobile view hierarchy (Android), giving the LLM clean, structured element data to reason over.
- **Vision-based (Architecture B)** — takes a screenshot of the live UI and interprets it visually, using object detection to locate elements and OCR to read their text, producing a "Visual DOM" even for elements that are hidden or obfuscated in the underlying markup.

An LLM processes this information — together with a running history of what's already been explored — to decide what to do next, and afterward to synthesize everything observed into structured test cases. The long-term goal is to run both architectures on identical flows and compare which performs better, and under what conditions.

---

## Database

| Component | Responsibility |
|---|---|
| **init_db.js** | Creates the SQLite schema (`capstone.db`) with `Test_Case` and `Test_Execution` tables, with strict foreign keys and `ON DELETE CASCADE`. |
| **seedTests.js** / **insert_data.js** | Parses generated test case JSON (web and mobile) and inserts it into the database. |
| **generateReport.js** | Queries the database for pass/fail distribution and average execution time. |
| **seed_db.js** | Utility to reset the `Test_Execution` table for a clean demo run without touching stored test case definitions. |

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Playwright | Browser control, DOM extraction, screenshot capture |
| Appium + UIAutomator2 | Android UI control, view hierarchy fetching |
| Groq API (LLM inference) | Reasoning over UI structure and test case generation |
| YOLOv8 | Visual UI element detection |
| Tesseract OCR | Text extraction from detected UI regions |
| Node.js | Web pipeline runtime |
| Python 3 | Mobile pipeline and vision microservices runtime |
| SQLite | Structured storage for test cases and execution history |

---

## Team

| Member | SRN |
|---|---|
| Navya G N | PES2UG23CS372 |
| Nidhi K | PES2UG23CS383 |
| Nikita Kolathaya | PES2UG23CS387 |
| Sandeep | PES2UG23CS525 |
