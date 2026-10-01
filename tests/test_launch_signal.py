import json

import pytest


CONTRACT = "contracts/launch_signal.py"
GOOD_PAGE = "https://startup.example/"
OFFER = "A simple inventory dashboard for independent coffee shops."


def _good_rubric(note="The page clearly presents the offer and next step."):
    return json.dumps(
        {
            "evidence_sufficient": True,
            "offer_visible": True,
            "audience_clear": True,
            "cta_clear": True,
            "offer_matches": True,
            "note": note,
        }
    )


def test_empty_state(direct_deploy):
    contract = direct_deploy(CONTRACT)
    assert int(contract.get_review_count()) == 0
    assert contract.get_review(0) == ""


@pytest.mark.parametrize("offer", ["", "   ", "x" * 281])
def test_rejects_empty_or_oversized_offer(direct_vm, direct_deploy, offer):
    contract = direct_deploy(CONTRACT)
    with direct_vm.expect_revert("Offer statement must contain 1 to 280 characters"):
        contract.review_page(GOOD_PAGE, offer)


def test_rejects_oversized_page_url(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    with direct_vm.expect_revert("Provide one public HTTPS page URL"):
        contract.review_page("https://startup.example/" + "x" * 2100, OFFER)


@pytest.mark.parametrize(
    "url",
    [
        "http://startup.example/",
        "https://user:pass@startup.example/",
        "https://startup.example:443/",
        "https://localhost/",
        "https://service.local/",
        "https://service.internal/",
        "https://127.0.0.1/",
        "https://0177.0.0.1/",
        "https://0x7f.0.0.1/",
        "https://10.0.0.1/",
        "https://169.254.169.254/latest/",
        "https://startup..example/",
        "https://-startup.example/",
        "https://éxample.example/",
    ],
)
def test_rejects_non_public_or_malformed_host(direct_vm, direct_deploy, url):
    contract = direct_deploy(CONTRACT)
    with direct_vm.expect_revert("Provide one public HTTPS page URL"):
        contract.review_page(url, OFFER)


def test_canonicalizes_url_and_stores_consensus_review(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Launch page with product, audience, and signup action."})
    direct_vm.mock_llm(r".*", _good_rubric())

    review_id = contract.review_page("https://STARTUP.example/#hero", OFFER)
    record = json.loads(contract.get_review(review_id))

    assert int(review_id) == 0
    assert int(contract.get_review_count()) == 1
    assert record["page_url"] == "https://startup.example/"
    assert record["status"] == "READY"
    assert record["offer_visible"] is True
    assert record["audience_clear"] is True
    assert record["cta_clear"] is True
    assert record["offer_matches"] is True
    assert record["note"] == "The page clearly presents the offer and next step."
    assert record["consensus_rule"] == "independent_agreement_on_evidence_sufficiency_and_four_rubric_flags"
    assert record["page_snapshot"] is False


def test_page_fetch_failure_records_unclear(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    direct_vm.mock_web(r"startup\.example/", {"status": 503, "body": "unavailable"})

    review_id = contract.review_page(GOOD_PAGE, OFFER)
    record = json.loads(contract.get_review(review_id))
    assert record["status"] == "UNCLEAR"
    assert record["evidence_sufficient"] is False


def test_derives_needs_work_when_a_rubric_item_is_missing(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Visible product page."})
    direct_vm.mock_llm(
        r".*",
        json.dumps(
            {
                "evidence_sufficient": True,
                "offer_visible": True,
                "audience_clear": True,
                "cta_clear": False,
                "offer_matches": True,
                "note": "The next action is not easy to find.",
            }
        ),
    )

    review_id = contract.review_page(GOOD_PAGE, OFFER)
    record = json.loads(contract.get_review(review_id))
    assert record["status"] == "NEEDS_WORK"
    assert record["cta_clear"] is False


def test_incomplete_model_output_falls_back_to_unclear(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Some public page text."})
    direct_vm.mock_llm(r".*", json.dumps({"offer_visible": True, "note": "missing fields"}))

    review_id = contract.review_page(GOOD_PAGE, OFFER)
    record = json.loads(contract.get_review(review_id))
    assert record["status"] == "UNCLEAR"
    assert record["evidence_sufficient"] is False


def test_consensus_rejects_changed_rubric_field(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Visible product page."})
    direct_vm.mock_llm(r".*", _good_rubric())
    contract.review_page(GOOD_PAGE, OFFER)

    direct_vm.clear_mocks()
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Visible product page."})
    direct_vm.mock_llm(
        r".*",
        json.dumps(
            {
                "evidence_sufficient": True,
                "offer_visible": True,
                "audience_clear": True,
                "cta_clear": False,
                "offer_matches": True,
                "note": "No action is visible.",
            }
        ),
    )

    assert direct_vm.run_validator() is False


def test_consensus_allows_different_note_when_rubric_matches(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Visible product page."})
    direct_vm.mock_llm(r".*", _good_rubric("Leader's note."))
    contract.review_page(GOOD_PAGE, OFFER)

    direct_vm.clear_mocks()
    direct_vm.mock_web(r"startup\.example/", {"status": 200, "body": "Different page wording; same visible rubric."})
    direct_vm.mock_llm(r".*", _good_rubric("Validator note."))

    assert direct_vm.run_validator() is True
