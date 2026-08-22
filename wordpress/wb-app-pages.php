<?php
/**
 * Plugin Name: wb — app pages
 * Description: Creates or updates the WordPress page for an app published by wb, masked to the live app with the Content Mask plugin. Exposed both as a REST route (for the deploy hook) and as an Abilities API ability (for AI agents via MCP).
 * Version:     1.1.0
 * Author:      wb
 *
 * Install: copy this file to wp-content/mu-plugins/wb-app-pages.php
 * (create the directory if it does not exist — must-use plugins need no
 * activation, which is what you want for something a deploy depends on).
 *
 * Requires: the Content Mask plugin, and a WordPress user with an Application
 * Password (Users → Profile → Application Passwords) who can publish pages.
 * The abilities are additionally gated on WordPress 6.9+ and are simply absent
 * below that — the REST route, and therefore deploying, does not care.
 *
 * Why a REST route rather than the stock /wp/v2/pages endpoint: Content Mask
 * stores its configuration in post meta, and the REST API drops meta keys that
 * were not registered with show_in_rest. Posting the masking keys to the stock
 * endpoint returns 201 and silently ignores them — a blank page on the live
 * domain, reported as a success.
 *
 * Why both a route and an ability: they have different callers, and neither
 * substitutes for the other. wb's deploy runs in a serverless function that
 * wants one authenticated POST, so it uses the route. Setting this up and
 * checking on it afterwards — "what did Content Mask actually write on page
 * 412?" — is agent work, so that goes through MCP. Both call the same
 * function below, because two implementations of one upsert is how the two
 * paths quietly stop agreeing.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE CONSTANT.
 *
 * Content Mask's meta keys are its private storage, not a documented API, so
 * these are the names most likely to be wrong — and if they are wrong, the
 * page is created and simply is not masked. Everything else in the
 * integration is independent of them; this array is the only place they
 * appear.
 *
 * To verify against your install: mask one page by hand in wp-admin, then
 *
 *     wp post meta list <page-id>
 *
 * (or ask an agent for the wb/inspect-app-page ability, which reports exactly
 * these keys) and reconcile the names below with what the plugin wrote.
 * ─────────────────────────────────────────────────────────────────────────
 */
const WB_CONTENT_MASK_META = array(
	'enable' => 'content_mask_enable',                // '1' to turn masking on
	'url'    => 'content_mask_url',                   // where the mask points
	'method' => 'content_mask_method',                // iframe | redirect | download
	'expiry' => 'content_mask_transient_expiration',  // cache lifetime; written on create only
);

/** Cache lifetime written when the page is first created. 0 = no caching. */
const WB_CONTENT_MASK_DEFAULT_EXPIRY = '0';

/**
 * Why the mode is not a matter of taste, stated once and reused as the
 * description an agent reads before choosing one.
 */
const WB_MODE_DESCRIPTION = 'How Content Mask serves the app: "iframe" keeps the WordPress URL in the address bar; "redirect" sends the visitor to the app. Use "redirect" for any app with Google sign-in — Google serves its consent screen with X-Frame-Options: DENY, so an iframed OAuth app looks perfect until somebody clicks sign in and lands in a blank frame.';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * The shared implementation. Both callers below are thin wrappers over this.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Idempotent on `slug`: wb derives the slug deterministically from the site's
 * id, so republishing the same app lands on the same page instead of leaving a
 * trail of near-duplicates on the clinic's site.
 *
 * @param array $args slug, url, mode (required); title, status, parent (optional).
 * @return array|WP_Error
 */
function wb_app_page_save( array $args ) {
	$slug = sanitize_title( (string) ( $args['slug'] ?? '' ) );
	if ( '' === $slug ) {
		return new WP_Error( 'wb_bad_slug', 'slug is required', array( 'status' => 400 ) );
	}

	$title = sanitize_text_field( (string) ( $args['title'] ?? '' ) );
	if ( '' === $title ) {
		$title = $slug;
	}

	// The masked URL ends up in an iframe src / a redirect Location on a public
	// page. Anything but http(s) — javascript:, data: — has no business there.
	$url = esc_url_raw( trim( (string) ( $args['url'] ?? '' ) ), array( 'http', 'https' ) );
	if ( '' === $url ) {
		return new WP_Error( 'wb_bad_url', 'url must be an http(s) URL', array( 'status' => 400 ) );
	}

	$mode = (string) ( $args['mode'] ?? '' );
	if ( ! in_array( $mode, array( 'iframe', 'redirect' ), true ) ) {
		return new WP_Error( 'wb_bad_mode', 'mode must be iframe or redirect', array( 'status' => 400 ) );
	}

	$status = (string) ( $args['status'] ?? 'draft' );
	if ( ! in_array( $status, array( 'draft', 'publish', 'private' ), true ) ) {
		$status = 'draft';
	}

	$parent = absint( $args['parent'] ?? 0 );

	$existing = get_posts(
		array(
			'name'             => $slug,
			'post_type'        => 'page',
			'post_status'      => 'any',
			'numberposts'      => 1,
			'suppress_filters' => false,
		)
	);
	$page    = $existing ? $existing[0] : null;
	$created = null === $page;

	$postarr = array(
		'post_type'   => 'page',
		'post_name'   => $slug,
		'post_title'  => $title,
		'post_parent' => $parent,
	);

	if ( $created ) {
		$postarr['post_status']  = $status;
		$postarr['post_content'] = '';
		$page_id                 = wp_insert_post( $postarr, true );
	} else {
		$postarr['ID'] = $page->ID;
		// Never demote a page somebody has already published. A deploy running
		// with the default WB_WORDPRESS_STATUS=draft must not pull a live page
		// off the clinic's site.
		if ( 'publish' !== $page->post_status ) {
			$postarr['post_status'] = $status;
		}
		$page_id = wp_update_post( $postarr, true );
	}

	if ( is_wp_error( $page_id ) ) {
		return new WP_Error( 'wb_save_failed', $page_id->get_error_message(), array( 'status' => 500 ) );
	}

	update_post_meta( $page_id, WB_CONTENT_MASK_META['enable'], '1' );
	update_post_meta( $page_id, WB_CONTENT_MASK_META['url'], $url );
	update_post_meta( $page_id, WB_CONTENT_MASK_META['method'], $mode );
	if ( $created ) {
		// Only on create: a cache lifetime somebody set in wp-admin is a
		// deliberate choice, and a deploy should not silently reset it.
		update_post_meta( $page_id, WB_CONTENT_MASK_META['expiry'], WB_CONTENT_MASK_DEFAULT_EXPIRY );
	}

	return array(
		'id'      => (int) $page_id,
		'link'    => get_permalink( $page_id ),
		'slug'    => $slug,
		'mode'    => $mode,
		'status'  => get_post_status( $page_id ),
		'created' => $created,
	);
}

/**
 * What Content Mask actually stored on a page.
 *
 * This is the answer to the one question the whole integration rests on, and
 * it reads back the same constant it was written from — so if the key names
 * here are wrong, this reports empty values rather than confirming a masking
 * that never happened.
 *
 * @param int $page_id
 * @return array|WP_Error
 */
function wb_app_page_inspect( $page_id ) {
	$page_id = absint( $page_id );
	$page    = $page_id ? get_post( $page_id ) : null;
	if ( ! $page || 'page' !== $page->post_type ) {
		return new WP_Error( 'wb_not_found', 'no such page', array( 'status' => 404 ) );
	}

	// Deliberately only the masking keys: an ability that returns whatever meta
	// a page happens to carry is a data-exfiltration tool wearing a diagnostic
	// hat.
	$meta = array();
	foreach ( WB_CONTENT_MASK_META as $name => $key ) {
		$value        = get_post_meta( $page_id, $key, true );
		$stored       = is_scalar( $value ) ? (string) $value : '';
		$meta[ $name ] = array(
			'key'   => $key,
			'value' => $stored,
			'set'   => '' !== $stored,
		);
	}

	return array(
		'id'     => (int) $page_id,
		'slug'   => $page->post_name,
		'title'  => $page->post_title,
		'status' => $page->post_status,
		'link'   => get_permalink( $page_id ),
		'meta'   => $meta,
	);
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Caller 1 — the REST route wb's deploy hook posts to.
 * ─────────────────────────────────────────────────────────────────────────
 */
add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'wb/v1',
			'/app-page',
			array(
				'methods'             => 'POST',
				'callback'            => 'wb_app_page_rest',
				'permission_callback' => function () {
					return current_user_can( 'publish_pages' );
				},
			)
		);
	}
);

function wb_app_page_rest( WP_REST_Request $request ) {
	$result = wb_app_page_save(
		array(
			'slug'   => $request->get_param( 'slug' ),
			'title'  => $request->get_param( 'title' ),
			'url'    => $request->get_param( 'url' ),
			'mode'   => $request->get_param( 'mode' ),
			'status' => $request->get_param( 'status' ),
			'parent' => $request->get_param( 'parent' ),
		)
	);
	if ( is_wp_error( $result ) ) {
		return $result;
	}
	return new WP_REST_Response( $result, $result['created'] ? 201 : 200 );
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Caller 2 — the Abilities API (WordPress 6.9+), which the MCP adapter turns
 * into tools an agent can call.
 *
 * Guarded on function_exists rather than a version check: the API also ships
 * as a feature plugin, and a site that has it should get the abilities
 * whatever its core version says.
 * ─────────────────────────────────────────────────────────────────────────
 */
add_action(
	'wp_abilities_api_categories_init',
	function () {
		if ( ! function_exists( 'wp_register_ability_category' ) ) {
			return;
		}
		wp_register_ability_category(
			'wb',
			array(
				'label'       => 'wb app pages',
				'description' => 'Pages that front an app published by the wb website builder.',
			)
		);
	}
);

add_action(
	'wp_abilities_api_init',
	function () {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}

		wp_register_ability(
			'wb/upsert-app-page',
			array(
				'label'       => 'Create or update an app page',
				'description' => 'Create the WordPress page that fronts an app published by wb, or update the existing one, masked to the live app with Content Mask. Idempotent on slug: calling it again with the same slug updates that page rather than making another.',
				'category'    => 'wb',
				'input_schema' => array(
					'type'       => 'object',
					'properties' => array(
						'slug'   => array(
							'type'        => 'string',
							'description' => 'Page slug. wb derives this from the site id so republishing hits the same page.',
						),
						'url'    => array(
							'type'        => 'string',
							'description' => 'The live app URL the page is masked to. Must be http(s).',
						),
						'mode'   => array(
							'type'        => 'string',
							'enum'        => array( 'iframe', 'redirect' ),
							'description' => WB_MODE_DESCRIPTION,
						),
						'title'  => array(
							'type'        => 'string',
							'description' => 'Page title. Defaults to the slug.',
						),
						'status' => array(
							'type'        => 'string',
							'enum'        => array( 'draft', 'publish', 'private' ),
							'default'     => 'draft',
							'description' => 'Status for a page being created. An already-published page is never demoted.',
						),
						'parent' => array(
							'type'        => 'integer',
							'description' => 'Optional parent page id to nest under.',
						),
					),
					'required'   => array( 'slug', 'url', 'mode' ),
				),
				'output_schema' => array(
					'type'       => 'object',
					'properties' => array(
						'id'      => array( 'type' => 'integer' ),
						'link'    => array( 'type' => 'string' ),
						'slug'    => array( 'type' => 'string' ),
						'mode'    => array( 'type' => 'string' ),
						'status'  => array( 'type' => 'string' ),
						'created' => array( 'type' => 'boolean' ),
					),
				),
				'execute_callback'    => function ( $input ) {
					return wb_app_page_save( is_array( $input ) ? $input : array() );
				},
				'permission_callback' => function () {
					return current_user_can( 'publish_pages' );
				},
				'meta'                => array(
					// Abilities are private by default; this is what the MCP
					// adapter looks for before exposing one as a tool.
					'public'      => true,
					'annotations' => array(
						'readonly'    => false,
						'destructive' => false,
						// Same slug and inputs → the same one page, every time.
						'idempotent'  => true,
					),
				),
			)
		);

		wp_register_ability(
			'wb/inspect-app-page',
			array(
				'label'       => 'Inspect an app page\'s masking',
				'description' => 'Report the Content Mask configuration actually stored on a page: which meta keys were read, their values, and whether each is set. Use this to confirm masking really applied after a deploy — a page can be created successfully and left unmasked if the plugin\'s meta key names differ from the ones wb writes.',
				'category'    => 'wb',
				'input_schema' => array(
					'type'       => 'object',
					'properties' => array(
						'page_id' => array(
							'type'        => 'integer',
							'description' => 'The WordPress page id to inspect.',
						),
					),
					'required'   => array( 'page_id' ),
				),
				'output_schema' => array(
					'type'       => 'object',
					'properties' => array(
						'id'     => array( 'type' => 'integer' ),
						'slug'   => array( 'type' => 'string' ),
						'title'  => array( 'type' => 'string' ),
						'status' => array( 'type' => 'string' ),
						'link'   => array( 'type' => 'string' ),
						'meta'   => array(
							'type'        => 'object',
							'description' => 'One entry per Content Mask key: its name, the stored value, and whether it is set.',
						),
					),
				),
				'execute_callback'    => function ( $input ) {
					return wb_app_page_inspect( is_array( $input ) ? ( $input['page_id'] ?? 0 ) : 0 );
				},
				'permission_callback' => function () {
					return current_user_can( 'edit_pages' );
				},
				'meta'                => array(
					'public'      => true,
					'annotations' => array(
						'readonly'    => true,
						'destructive' => false,
						'idempotent'  => true,
					),
				),
			)
		);
	}
);
