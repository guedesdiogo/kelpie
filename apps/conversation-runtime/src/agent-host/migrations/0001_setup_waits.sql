CREATE TABLE `setup_waits` (
	`conversation` text NOT NULL,
	`step` text NOT NULL,
	`until` integer NOT NULL,
	PRIMARY KEY(`conversation`, `step`)
);
