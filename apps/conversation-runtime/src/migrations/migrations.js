import m0000 from "./0000_init.sql";
import m0001 from "./0001_turn_settings.sql";
import m0002 from "./0002_drop_turn_system_prompt.sql";
import m0003 from "./0003_inbound_stamp.sql";
import m0004 from "./0004_turn_usage.sql";
import m0005 from "./0005_history_checkpoints.sql";
import m0006 from "./0006_turn_context.sql";
import m0007 from "./0007_turn_tools_key.sql";
import m0008 from "./0008_turn_kelpie_notes.sql";
import m0009 from "./0009_turn_access.sql";
import m0010 from "./0010_confirmations.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
    m0007,
    m0008,
    m0009,
    m0010,
  },
};
