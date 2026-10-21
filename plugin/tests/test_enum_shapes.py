"""FR-ENUM-ONEOF — the server half of the blank-allowing choice field.

The thin client renders a select only if it can READ the shape, and the shape
drf-spectacular emits for `choices=... , blank=True` is NOT a plain `$ref`: the
property splits into `{"oneOf": [<ValueEnum>, BlankEnum]}` (hooks.py:145-164,
ENUM_ADD_EXPLICIT_BLANK_NULL_CHOICE defaults True) — case C of
docs/independent-enums.md §2. The demo rig carries such a field on purpose
(`shop.models.Product.priority`, a FREE enum with a real empty state) so the
shape stays live-proven instead of guessed, and this module pins what the
client's fix depends on:

- the document distinguishes case C (`oneOf`) from case A/B (bare `$ref`), so a
  normalizer that only follows `$ref` is observably wrong, not merely narrow;
- `""` is a legal value (200) — the select needs its empty option;
- a made-up value is a 400 — which is exactly what the degraded free-text input
  used to let a user submit;
- `null` is a 400 too — a blank CharField is NOT a nullable one. This is why the
  client maps BlankEnum to "omit the key" and only NullEnum to
  `FieldSpec.nullable` (see app/src/lib/openapi.ts `enumShapeOf`).

Infrastructure note: same in-process rig as test_rbac_roles — conftest mounts
the demo apps, this module creates the test DB with Django's own DiscoverRunner
(pytest-django deliberately absent). The schema test needs no DB at all.
"""
import json
import tempfile
from pathlib import Path

import pytest
from django.contrib.auth.models import User
from django.core.management import call_command
from django.db import transaction
from django.test.runner import DiscoverRunner
from django.test.utils import setup_test_environment, teardown_test_environment
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient


@pytest.fixture(scope="module")
def demo_db():
    setup_test_environment()
    runner = DiscoverRunner(interactive=False, verbosity=0)
    old_config = runner.setup_databases()
    yield
    runner.teardown_databases(old_config)
    teardown_test_environment()


@pytest.fixture
def db(demo_db):
    with transaction.atomic():
        yield
        transaction.set_rollback(True)


@pytest.fixture
def staff_client(db):
    user = User.objects.create_superuser("enumstaff", "e@example.com", "pw")
    token, _ = Token.objects.get_or_create(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
    return client


@pytest.fixture
def product(db):
    from shop.models import Category, Product

    category = Category.objects.create(name="Bakery")
    return Product.objects.create(
        category=category, name="Sourdough Loaf", price="4.50", stock=3, priority="low"
    )


def _schema():
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "schema.json"
        call_command("spectacular", "--format", "openapi-json", file=str(out))
        return json.loads(out.read_text())


class TestSchemaShape:
    def test_blank_choices_field_is_emitted_as_case_c_oneOf(self):
        schema = _schema()
        for name in ("Product", "ProductRequest", "PatchedProductRequest"):
            prop = schema["components"]["schemas"][name]["properties"]["priority"]
            assert "oneOf" in prop, f"{name} lost the case-C split: {prop}"
            assert "$ref" not in prop
            members = [m["$ref"].split("/")[-1] for m in prop["oneOf"]]
            assert "PriorityEnum" in members
            assert "BlankEnum" in members, "the empty state must be in the document"

    def test_value_component_carries_only_the_declared_values(self):
        enum = _schema()["components"]["schemas"]["PriorityEnum"]
        assert enum["enum"] == ["low", "normal", "high"]
        assert enum["type"] == "string"

    def test_blank_field_is_not_required_but_a_plain_one_is(self):
        request = _schema()["components"]["schemas"]["ProductRequest"]
        assert "priority" not in request.get("required", [])
        assert "name" in request["required"]

    def test_case_A_B_shape_stays_a_bare_ref(self):
        # The control: the fix must not blur the two shapes. Order.status has no
        # blank member, so it stays a single $ref — which is what normalizeOpenAPI
        # resolved correctly even before the oneOf branch existed.
        prop = _schema()["components"]["schemas"]["Order"]["properties"]["status"]
        assert prop == {"$ref": "#/components/schemas/StatusEnum"}


class TestWireContract:
    def test_blank_value_is_accepted_and_round_trips(self, staff_client, product):
        r = staff_client.patch(f"/api/products/{product.pk}/", {"priority": ""}, format="json")
        assert r.status_code == 200, r.content
        assert r.json()["priority"] == ""

    def test_a_made_up_value_is_a_400(self, staff_client, product):
        # A degraded free-text input hands the user exactly this failure.
        r = staff_client.patch(
            f"/api/products/{product.pk}/", {"priority": "urgent"}, format="json"
        )
        assert r.status_code == 400, r.content
        assert "priority" in r.json()

    def test_null_is_a_400_because_blank_is_not_nullable(self, staff_client, product):
        # The decisive measurement for the client: BlankEnum means "may be
        # omitted", never "send null". RecordForm.buildPayload sends null for a
        # nullable field, so treating the blank member as nullable would 400.
        r = staff_client.patch(f"/api/products/{product.pk}/", {"priority": None}, format="json")
        assert r.status_code == 400, r.content

    def test_declared_value_passes_and_omitting_leaves_the_default(self, staff_client):
        from shop.models import Category, Product

        category = Category.objects.create(name="Dairy")
        r = staff_client.post(
            "/api/products/",
            {"category": category.pk, "name": "Greek Yogurt", "price": "3.20", "priority": "high"},
            format="json",
        )
        assert r.status_code == 201, r.content
        assert r.json()["priority"] == "high"

        r2 = staff_client.post(
            "/api/products/",
            {"category": category.pk, "name": "Farm Butter", "price": "5.00"},
            format="json",
        )
        assert r2.status_code == 201, r2.content
        assert r2.json()["priority"] == "", "omitted key -> field default, not an error"
