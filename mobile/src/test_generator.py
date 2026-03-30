import json

def generate_test_cases(visual_dom):
    elements = visual_dom["elements"]

    steps = []
    
    for el in elements:
        if el["type"] == "input":
            steps.append({
                "action": "fill",
                "target": el["text"],
                "value": "test_value"
            })
        elif el["type"] == "button":
            steps.append({
                "action": "click",
                "target": el["text"]
            })

    test_case = {
        "objective": f"Test {visual_dom['screen']}",
        "steps": steps,
        "expected_result": "User completes flow successfully"
    }

    return test_case


if __name__ == "__main__":
    with open("../logs/sample_visual_dom.json") as f:
        visual_dom = json.load(f)

    test_case = generate_test_cases(visual_dom)

    with open("../logs/mobile_test_cases.json", "w") as f:
        json.dump(test_case, f, indent=2)

    print("✅ Test case generated")