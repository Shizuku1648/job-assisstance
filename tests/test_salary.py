from __future__ import annotations

import unittest

from app.salary import decode_boss_salary_text, salary_range_k, salary_ranges_overlap


class SalaryTest(unittest.TestCase):
    def test_decodes_boss_private_digits(self) -> None:
        self.assertEqual(decode_boss_salary_text("\ue033\ue031-\ue033\ue036K"), "20-25K")
        self.assertEqual(salary_range_k("\ue033\ue031-\ue033\ue036K"), (20, 25))

    def test_matches_overlapping_salary_ranges(self) -> None:
        expected = (20, 25)
        for salary in ("18-20K", "18-25K", "20-25K", "25-30K"):
            with self.subTest(salary=salary):
                self.assertTrue(salary_ranges_overlap(salary, *expected))

        for salary in ("10-19K", "26-30K", "面议"):
            with self.subTest(salary=salary):
                self.assertFalse(salary_ranges_overlap(salary, *expected))


if __name__ == "__main__":
    unittest.main()
