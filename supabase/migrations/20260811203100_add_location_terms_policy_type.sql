-- Forward-only enum boundary. The following migration installs the complete
-- four-policy publication contract before any location consent can be used.
alter type private.policy_type add value if not exists 'location_terms';
