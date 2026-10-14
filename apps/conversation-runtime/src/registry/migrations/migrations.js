import m0000 from "./0000_init.sql";
import m0001 from "./0001_seed_setup_agent.sql";
import m0002 from "./0002_agent_roles.sql";
import m0003 from "./0003_seed_main_agent.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
  },
};
