<?php
/**
 * Plugin Name: wb — app pages
 * Description: One REST route that creates or updates the WordPress page for an app published by wb, masked to the live app with the Content Mask plugin.
 * Version:     1.0.0
 * Author:      wb
 *
 * Install: copy this file to wp-content/mu-plugins/wb-app-pages.php
 * (create the directory if it does not exist — must-use plugins need no
 * activation, which is what you want for something a deploy depends on).
 *
 * Requires: the Content Mask plugin, and a WordPress user with an Application
 * Password (Users → Profile → Application Passwords) who can publish pages.
 *
 * Why this exists rather than the stock /wp/v2/pages endpoint: Content Mask
 * stores its configuration in post meta, and the REST API drops meta keys that
 * were not registered with show_in_rest. Posting the masking keys to the stock
 * endpoint returns 201 and silently ignores them — a blank page on the live
 * domain, reported as a success.
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
 * (or look at wp_postmeta for that post_id) and reconcile the keys below with
 * what the plugin actually wrote.
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

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'wb/v1',
			'/app-page',
			array(
				'methods'             => 'POST',
				'callback'            => 'wb_app_page_upsert',
				'permission_callback' => function () {
					return current_user_can( 'publish_pages' );
				},
			)
		);
	}
);

/**
 * Create the page for an app, or update the one this site already has.
 *
 * Idempotent on `slug`: wb derives the slug deterministically from the site's
 * id, so republishing the same app lands on the same page instead of leaving a
 * trail of near-duplicates on the clinic's site.
 */
function wb_app_page_upsert( WP_REST_Request $request ) {
	$slug = sanitize_title( (string) $request->get_param( 'slug' ) );
	if ( '' === $slug ) {
		return new WP_Error( 'wb_bad_slug', 'slug is required', array( 'status' => 400 ) );
	}

	$title = sanitize_text_field( (string) $request->get_param( 'title' ) );
	if ( '' === $title ) {
		$title = $slug;
	}

	// The masked URL ends up in an iframe src / a redirect Location on a public
	// page. Anything but http(s) — javascript:, data: — has no business there.
	$url    = esc_url_raw( trim( (string) $request->get_param( 'url' ) ), array( 'http', 'https' ) );
	if ( '' === $url ) {
		return new WP_Error( 'wb_bad_url', 'url must be an http(s) URL', array( 'status' => 400 ) );
	}

	$mode = (string) $request->get_param( 'mode' );
	if ( ! in_array( $mode, array( 'iframe', 'redirect' ), true ) ) {
		return new WP_Error( 'wb_bad_mode', 'mode must be iframe or redirect', array( 'status' => 400 ) );
	}

	$status = (string) $request->get_param( 'status' );
	if ( ! in_array( $status, array( 'draft', 'publish', 'private' ), true ) ) {
		$status = 'draft';
	}

	$parent = absint( $request->get_param( 'parent' ) );

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

	return new WP_REST_Response(
		array(
			'id'      => (int) $page_id,
			'link'    => get_permalink( $page_id ),
			'slug'    => $slug,
			'mode'    => $mode,
			'status'  => get_post_status( $page_id ),
			'created' => $created,
		),
		$created ? 201 : 200
	);
}
