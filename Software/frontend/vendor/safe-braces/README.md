Fork of micromatch/braces 3.0.3 (MIT; original LICENSE retained).

Mitigates GHSA-vfj7-8cjw-p6xm by limiting parser nesting to 128 and validating AST depth, cycles, and node count before recursive compile, expand, or stringify. Inputs exceeding these limits throw RangeError. No upstream patched release is claimed.
