"""ToolTrace intelligence: late-return and loss risk, and unusual check-out detection."""

import os
from zoneinfo import ZoneInfo

__version__ = "1.0.0"

# The shop floor's local time zone. "Night shift" and "weekend" are local ideas.
SITE_TZ = ZoneInfo(os.environ.get("TOOLTRACE_SITE_TZ", "Asia/Kolkata"))

# A return this many hours after the due time still counts as on time.
LATE_GRACE_HOURS = 0.5
# Not back this many hours after the due time: treated as lost.
LOSS_AFTER_HOURS = 7 * 24
