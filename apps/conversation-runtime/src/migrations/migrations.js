import m0000 from "./0000_init.sql";
import m0001 from "./0001_turn_settings.sql";
import m0002 from "./0002_drop_turn_system_prompt.sql";
import m0003 from "./0003_inbound_stamp.sql";
import m0004 from "./0004_turn_usage.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
  },
};
