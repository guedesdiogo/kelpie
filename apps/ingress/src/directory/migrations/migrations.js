import m0000 from "./0000_green_energizer.sql";
import m0001 from "./0001_polite_bastion.sql";
import m0002 from "./0002_spicy_secret_warriors.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
